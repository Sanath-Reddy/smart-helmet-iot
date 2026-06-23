require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const twilio = require('twilio');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// State Management
let esp32Connected = false;
let activeEsp32Sockets = new Set();
let lastSmsSentTime = 0;
const SMS_COOLDOWN_MS = 30000; // 30-second rate limiting cooldown

// Latest Telemetry State
let telemetryState = {
  device_id: "ESP32_HELMET_01",
  accident: false,
  gps: {
    lat: 12.9716, // Default Bangalore coordinates
    lng: 77.5946,
    valid: false,
    stale: true,
    timestamp: Date.now()
  },
  mpu: {
    ax: 0.0,
    ay: 0.0,
    az: 1.0, // 1g gravity default
    gx: 0.0,
    gy: 0.0,
    gz: 0.0
  },
  gas_ppm: 350,
  buffered: false,
  is_simulated: true,
  last_updated: Date.now()
};

// Initialize Twilio
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log("[SMS] Twilio client initialized successfully.");
  } catch (err) {
    console.error("[SMS Error] Failed to initialize Twilio:", err.message);
  }
} else {
  console.log("[SMS Config] Twilio credentials missing. SMS will run in simulated mode (console logs).");
}

// Helper: Dispatch Twilio SMS
async function sendSmsAlert(messageBody) {
  const now = Date.now();
  if (now - lastSmsSentTime < SMS_COOLDOWN_MS) {
    const waitTime = Math.ceil((SMS_COOLDOWN_MS - (now - lastSmsSentTime)) / 1000);
    console.log(`[SMS Cooldown] Rate limit active. Wait ${waitTime}s. Suppressing: "${messageBody}"`);
    return { success: false, reason: 'rate_limited', cooldownRemaining: waitTime };
  }

  lastSmsSentTime = now;
  console.log(`[SMS Alert Dispatch] sending: "${messageBody}"`);

  if (twilioClient && process.env.TWILIO_FROM_NUMBER && process.env.TWILIO_TO_NUMBER) {
    try {
      const response = await twilioClient.messages.create({
        body: messageBody,
        from: process.env.TWILIO_FROM_NUMBER,
        to: process.env.TWILIO_TO_NUMBER
      });
      console.log(`[SMS Sent] Twilio SID: ${response.sid}`);
      return { success: true, sid: response.sid };
    } catch (err) {
      console.error(`[SMS Fail] Twilio error:`, err.message);
      return { success: false, error: err.message };
    }
  } else {
    console.log(`[SMS Simulated Dispatch] (Set Twilio credentials in .env to send real SMS)`);
    return { success: true, simulated: true };
  }
}

// HTTP API: Trigger SOS Alert from web panel
app.post('/api/sos', async (req, res) => {
  const { lat, lng, source } = req.body;
  const locationString = (lat && lng) ? `Lat: ${parseFloat(lat).toFixed(5)}, Lng: ${parseFloat(lng).toFixed(5)}` : "Unknown Location";
  const mapsUrl = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : "";
  
  const alertMsg = `⚠️ EMERGENCY SOS TRIGGERED! ⚠️\nSmart Helmet User needs assistance.\nSource: ${source || 'Web Dashboard'}\nLocation: ${locationString}\n${mapsUrl ? 'Track here: ' + mapsUrl : ''}`;
  
  const result = await sendSmsAlert(alertMsg);
  res.json({ success: true, smsResult: result });
});

// HTTP API: Nearby Hospitals and Police finder
app.get('/api/nearby-emergency', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: "Invalid lat/lng parameters" });
  }

  const radius = 5000; // 5 km search radius
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (apiKey) {
    try {
      console.log(`[Finder] Querying Google Places for lat:${lat}, lng:${lng}`);
      
      // Google Nearby Search for hospitals and police
      const fetchPlaces = async (type) => {
        const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=${type}&key=${apiKey}`;
        const response = await axios.get(url);
        return (response.data.results || []).map(place => ({
          id: place.place_id,
          name: place.name,
          type: type === 'hospital' ? 'Hospital' : 'Police Station',
          rating: place.rating || 'N/A',
          address: place.vicinity,
          open_now: place.opening_hours ? place.opening_hours.open_now : 'Unknown',
          lat: place.geometry.location.lat,
          lng: place.geometry.location.lng,
          phone: 'Call via Google Maps', // Phone numbers require a separate Place Details query
          directions_url: `https://www.google.com/maps/dir/?api=1&destination=${place.geometry.location.lat},${place.geometry.location.lng}`
        }));
      };

      const [hospitals, police] = await Promise.all([
        fetchPlaces('hospital'),
        fetchPlaces('police')
      ]);

      return res.json([...hospitals, ...police]);
    } catch (err) {
      console.error("[Finder Google Error] Falling back to OpenStreetMap...", err.message);
    }
  }

  // Fallback to OpenStreetMap Overpass API (no keys needed!)
  try {
    console.log(`[Finder] Querying OpenStreetMap Overpass API for lat:${lat}, lng:${lng}`);
    const overpassUrl = 'https://overpass-api.de/api/interpreter';
    
    // Search for hospitals/clinics and police stations within radius meters
    const query = `
      [out:json][timeout:15];
      (
        node["amenity"="hospital"](around:${radius}, ${lat}, ${lng});
        way["amenity"="hospital"](around:${radius}, ${lat}, ${lng});
        node["amenity"="police"](around:${radius}, ${lat}, ${lng});
        way["amenity"="police"](around:${radius}, ${lat}, ${lng});
        node["amenity"="clinic"](around:${radius}, ${lat}, ${lng});
      );
      out body center;
    `;

    const response = await axios.post(overpassUrl, query, {
      headers: { 'Content-Type': 'text/plain' }
    });

    const elements = response.data.elements || [];
    const results = elements.map(elem => {
      const isHospital = elem.tags.amenity === 'hospital' || elem.tags.amenity === 'clinic';
      const name = elem.tags.name || (isHospital ? 'Unnamed Hospital/Clinic' : 'Unnamed Police Station');
      const itemLat = elem.lat || (elem.center ? elem.center.lat : lat);
      const itemLng = elem.lon || (elem.center ? elem.center.lon : lng);
      
      return {
        id: elem.id.toString(),
        name: name,
        type: isHospital ? 'Hospital' : 'Police Station',
        rating: (Math.random() * 1.5 + 3.5).toFixed(1), // Mock rating since OSM doesn't store business ratings
        address: elem.tags['addr:street'] ? `${elem.tags['addr:street']} ${elem.tags['addr:housenumber'] || ''}`.trim() : 'Nearby Area',
        open_now: elem.tags.opening_hours ? 'Yes (Has Schedule)' : 'Unknown',
        lat: itemLat,
        lng: itemLng,
        phone: elem.tags.phone || elem.tags['contact:phone'] || 'N/A',
        directions_url: `https://www.google.com/maps/dir/?api=1&destination=${itemLat},${itemLng}`
      };
    });

    res.json(results);
  } catch (err) {
    console.error("[Finder Overpass Error] Generating mock emergency services...", err.message);
    
    // Absolute fallback: static mock data around the coordinates
    const mockServices = [
      {
        id: "mock-hosp-1",
        name: "City General Hospital (Simulated)",
        type: "Hospital",
        rating: "4.5",
        address: "1.2 km North-East",
        open_now: true,
        lat: lat + 0.008,
        lng: lng + 0.005,
        phone: "+91 99999 88888",
        directions_url: `https://www.google.com/maps/dir/?api=1&destination=${lat + 0.008},${lng + 0.005}`
      },
      {
        id: "mock-hosp-2",
        name: "St. Jude Emergency Center (Simulated)",
        type: "Hospital",
        rating: "4.1",
        address: "2.4 km South",
        open_now: true,
        lat: lat - 0.015,
        lng: lng - 0.002,
        phone: "+91 88888 77777",
        directions_url: `https://www.google.com/maps/dir/?api=1&destination=${lat - 0.015},${lng - 0.002}`
      },
      {
        id: "mock-police-1",
        name: "Metropolitan Police HQ (Simulated)",
        type: "Police Station",
        rating: "4.0",
        address: "0.8 km West",
        open_now: true,
        lat: lat + 0.002,
        lng: lng - 0.007,
        phone: "+91 77777 66666",
        directions_url: `https://www.google.com/maps/dir/?api=1&destination=${lat + 0.002},${lng - 0.007}`
      }
    ];
    res.json(mockServices);
  }
});

// Upgrade HTTP Server to WebSocket Server
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// WebSocket Server Handlers
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientType = url.pathname; // Should be '/esp32' or '/dashboard'

  console.log(`[WebSocket] Client connected of type: ${clientType}`);

  if (clientType === '/esp32') {
    activeEsp32Sockets.add(ws);
    esp32Connected = true;
    telemetryState.is_simulated = false;
    broadcastToDashboards({ type: "CONNECTION_STATUS", connected: true, isSimulated: false });

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        
        // Handle telemetry data incoming from ESP32
        telemetryState = {
          ...telemetryState,
          ...data,
          gps: {
            ...telemetryState.gps,
            ...data.gps,
            timestamp: Date.now()
          },
          is_simulated: false,
          last_updated: Date.now()
        };

        // Check if accident state is toggled from false -> true
        if (data.accident && !telemetryState.accident) {
          console.log("[Alert] Impact accident detected from ESP32 hardware!");
          const mapsLink = data.gps?.valid 
            ? `https://maps.google.com/?q=${data.gps.lat},${data.gps.lng}`
            : "No valid GPS fix.";
          const smsMsg = `⚠️ ACCIDENT DETECTED! ⚠️\nSmart Helmet has logged a major impact.\nLocation: Lat: ${data.gps?.lat || 'N/A'}, Lng: ${data.gps?.lng || 'N/A'}\n${data.gps?.valid ? 'Track: ' + mapsLink : ''}`;
          
          await sendSmsAlert(smsMsg);
        }

        // Keep local state synced
        telemetryState.accident = data.accident;

        // Broadcast raw telemetry to dashboard panels
        broadcastToDashboards({ type: "TELEMETRY", data: telemetryState });
      } catch (err) {
        console.error("[WebSocket ESP32 Error] Malformed message:", err.message);
      }
    });

    ws.on('close', () => {
      activeEsp32Sockets.delete(ws);
      console.log("[WebSocket] ESP32 client disconnected.");
      if (activeEsp32Sockets.size === 0) {
        esp32Connected = false;
        telemetryState.is_simulated = true;
        broadcastToDashboards({ type: "CONNECTION_STATUS", connected: false, isSimulated: true });
      }
    });

  } else if (clientType === '/dashboard') {
    // Immediately send current connection status and telemetry on connecting
    ws.send(JSON.stringify({
      type: "CONNECTION_STATUS",
      connected: esp32Connected,
      isSimulated: telemetryState.is_simulated
    }));
    
    ws.send(JSON.stringify({ type: "TELEMETRY", data: telemetryState }));

    ws.on('message', async (message) => {
      try {
        const clientMsg = JSON.parse(message.toString());
        
        // Handle simulator trigger commands from Frontend UI
        if (clientMsg.type === "TRIGGER_SIM_ACCIDENT") {
          console.log("[Simulator Control] Simulating accident impact event!");
          telemetryState.accident = true;
          telemetryState.mpu = {
            ax: 2.5 * (Math.random() > 0.5 ? 1 : -1),
            ay: 1.8 * (Math.random() > 0.5 ? 1 : -1),
            az: 2.1,
            gx: 240,
            gy: 180,
            gz: 310
          };
          broadcastToDashboards({ type: "TELEMETRY", data: telemetryState });

          // Send simulated SMS alert
          const mapsLink = `https://maps.google.com/?q=${telemetryState.gps.lat},${telemetryState.gps.lng}`;
          const smsMsg = `⚠️ ACCIDENT DETECTED (SIMULATED)! ⚠️\nSmart Helmet has logged a major impact.\nLocation: Lat: ${telemetryState.gps.lat}, Lng: ${telemetryState.gps.lng}\nTrack: ${mapsLink}`;
          await sendSmsAlert(smsMsg);

          // Force 8s latch reset timer in simulator mode
          setTimeout(() => {
            if (telemetryState.is_simulated && telemetryState.accident) {
              console.log("[Simulator Control] Auto-resetting simulated accident latch after 8s.");
              telemetryState.accident = false;
              telemetryState.mpu = { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 };
              broadcastToDashboards({ type: "TELEMETRY", data: telemetryState });
            }
          }, 8000);
        }

        if (clientMsg.type === "UPDATE_SIM_GAS") {
          telemetryState.gas_ppm = parseInt(clientMsg.value) || 0;
          broadcastToDashboards({ type: "TELEMETRY", data: telemetryState });
        }

        if (clientMsg.type === "SET_SIM_GPS") {
          telemetryState.gps.lat = parseFloat(clientMsg.lat);
          telemetryState.gps.lng = parseFloat(clientMsg.lng);
          telemetryState.gps.valid = true;
          telemetryState.gps.stale = false;
          telemetryState.gps.timestamp = Date.now();
          broadcastToDashboards({ type: "TELEMETRY", data: telemetryState });
        }
      } catch (err) {
        console.error("[WebSocket Dashboard Error] Message parsing failed:", err.message);
      }
    });
  }
});

// Helper: Broadcast messages to all connected web dashboards
function broadcastToDashboards(packet) {
  const jsonStr = JSON.stringify(packet);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      // Parse query parameters to identify dashboards
      try {
        client.send(jsonStr);
      } catch (e) {
        console.error("[WS Broadcast error]", e.message);
      }
    }
  });
}

// Active Simulator Loop (Runs only when hardware ESP32 is offline)
let simulationInterval = setInterval(() => {
  if (!esp32Connected) {
    // Create subtle fluctuations in MPU data
    telemetryState.mpu = {
      ax: (Math.random() * 0.15 - 0.075).toFixed(3),
      ay: (Math.random() * 0.15 - 0.075).toFixed(3),
      az: (0.95 + Math.random() * 0.1).toFixed(3), // Floating around 1g
      gx: (Math.random() * 4 - 2).toFixed(1),
      gy: (Math.random() * 4 - 2).toFixed(1),
      gz: (Math.random() * 4 - 2).toFixed(1)
    };

    // Fluctuating Air quality
    const gasDiff = Math.floor(Math.random() * 20 - 10);
    telemetryState.gas_ppm = Math.max(100, Math.min(10000, telemetryState.gas_ppm + gasDiff));

    // Slow drifting GPS route (Bangalore center simulation)
    telemetryState.gps.lat += (Math.random() * 0.0001 - 0.00005);
    telemetryState.gps.lng += (Math.random() * 0.0001 - 0.00005);
    telemetryState.gps.valid = true;
    telemetryState.gps.stale = false;
    telemetryState.gps.timestamp = Date.now();

    telemetryState.is_simulated = true;
    telemetryState.last_updated = Date.now();

    broadcastToDashboards({ type: "TELEMETRY", data: telemetryState });
  }
}, 2000);

// Graceful cleanup
process.on('SIGTERM', () => {
  clearInterval(simulationInterval);
  server.close();
});

// Start Server
server.listen(port, () => {
  console.log(`==================================================`);
  console.log(`Smart Helmet IoT Backend Server running on port ${port}`);
  console.log(`Web Dashboard: http://localhost:${port}`);
  console.log(`WebSocket URL: ws://localhost:${port}`);
  console.log(`==================================================`);
});
