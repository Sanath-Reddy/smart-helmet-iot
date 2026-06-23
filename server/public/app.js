// Aegis Helmet - Dashboard Logic

let socket;
let map;
let riderMarker;
let emergencyMarkers = [];
let imuChart;
let lastGpsTimestamp = Date.now();
let gpsStalenessTimer;

// Sound Effects for Alarm (using Web Audio API to avoid external asset dependency)
let audioCtx = null;
let sirenInterval = null;

function playSirenSound() {
  if (sirenInterval) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    sirenInterval = setInterval(() => {
      if (!audioCtx) return;
      let osc = audioCtx.createOscillator();
      let gain = audioCtx.createGain();
      
      osc.type = 'sine';
      // Dual tone siren sound
      osc.frequency.setValueAtTime(800, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.4);
      
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      
      osc.start();
      osc.stop(audioCtx.currentTime + 0.5);
    }, 600);
  } catch (e) {
    console.warn("Audio Context block or unsupported:", e);
  }
}

function stopSirenSound() {
  if (sirenInterval) {
    clearInterval(sirenInterval);
    sirenInterval = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
}

// Initializing the Leaflet Map with Dark Matter Tiles
function initMap(lat, lng) {
  map = L.map('leaflet-map').setView([lat, lng], 14);

  // CartoDB Dark Matter Map Tiles (Premium Dark aesthetics, no API key needed)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  // Custom Rider Helmet Icon
  const helmetIcon = L.divIcon({
    html: '<div style="background-color: #3b82f6; width: 14px; height: 14px; border: 3px solid white; border-radius: 50%; box-shadow: 0 0 10px #3b82f6;"></div>',
    className: 'rider-marker-icon',
    iconSize: [14, 14]
  });

  riderMarker = L.marker([lat, lng], { icon: helmetIcon }).addTo(map);
  riderMarker.bindPopup("<b>Rider Location</b>").openPopup();
}

// Initializing Chart.js for Accelerometer readings
function initIMUChart() {
  const ctx = document.getElementById('imuChart').getContext('2d');
  
  imuChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array(15).fill(''),
      datasets: [
        {
          label: 'Ax',
          data: Array(15).fill(0),
          borderColor: '#ff4a5a',
          borderWidth: 1.5,
          tension: 0.3,
          pointRadius: 0
        },
        {
          label: 'Ay',
          data: Array(15).fill(0),
          borderColor: '#10b981',
          borderWidth: 1.5,
          tension: 0.3,
          pointRadius: 0
        },
        {
          label: 'Az',
          data: Array(15).fill(1),
          borderColor: '#06b6d4',
          borderWidth: 1.5,
          tension: 0.3,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            boxWidth: 12,
            font: { size: 10 },
            color: '#9ca3af'
          }
        }
      },
      scales: {
        x: { display: false },
        y: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#6b7280', font: { size: 9 } }
        }
      }
    }
  });
}

// Push Accelerometer readings to Live Chart
function updateIMUChart(ax, ay, az) {
  if (!imuChart) return;
  
  imuChart.data.datasets[0].data.shift();
  imuChart.data.datasets[0].data.push(parseFloat(ax));
  
  imuChart.data.datasets[1].data.shift();
  imuChart.data.datasets[1].data.push(parseFloat(ay));
  
  imuChart.data.datasets[2].data.shift();
  imuChart.data.datasets[2].data.push(parseFloat(az));
  
  imuChart.update('none'); // Update without full animation for performance
}

// Connect to WebSockets
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}/dashboard`;
  
  console.log(`[WS] Connecting to ${wsUrl}...`);
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log("[WS] Connected to Smart Helmet Server.");
    document.getElementById('conn-badge').className = "badge status-connected";
    document.getElementById('conn-text').textContent = "Server Online";
  };

  socket.onmessage = (event) => {
    try {
      const packet = JSON.parse(event.data);
      
      if (packet.type === "CONNECTION_STATUS") {
        updateConnectionUI(packet.connected, packet.isSimulated);
      } else if (packet.type === "TELEMETRY") {
        updateTelemetryUI(packet.data);
      }
    } catch (e) {
      console.error("[WS] Error decoding message:", e);
    }
  };

  socket.onclose = () => {
    console.warn("[WS] Socket disconnected. Reconnecting in 3s...");
    document.getElementById('conn-badge').className = "badge status-offline";
    document.getElementById('conn-text').textContent = "Offline (Reconnecting)";
    setTimeout(connectWebSocket, 3000);
  };
}

// Update connection badges
function updateConnectionUI(connected, isSimulated) {
  const badge = document.getElementById('conn-badge');
  const txt = document.getElementById('conn-text');
  const simActiveBadge = document.getElementById('sim-active-badge');
  
  if (isSimulated) {
    badge.className = "badge status-simulating";
    txt.textContent = "Simulation Mode";
    simActiveBadge.style.display = "inline-flex";
  } else if (connected) {
    badge.className = "badge status-connected";
    txt.textContent = "ESP32 Live";
    simActiveBadge.style.display = "none";
  } else {
    badge.className = "badge status-offline";
    txt.textContent = "Offline";
    simActiveBadge.style.display = "none";
  }
}

// Update telemetry dashboard dials and cards
function updateTelemetryUI(data) {
  // 1. MPU6050
  document.getElementById('imu-ax').textContent = parseFloat(data.mpu.ax).toFixed(2);
  document.getElementById('imu-ay').textContent = parseFloat(data.mpu.ay).toFixed(2);
  document.getElementById('imu-az').textContent = parseFloat(data.mpu.az).toFixed(2);
  updateIMUChart(data.mpu.ax, data.mpu.ay, data.mpu.az);

  // 2. MQ135 Gas
  const gasPpm = parseInt(data.gas_ppm);
  document.getElementById('gas-ppm-val').textContent = gasPpm;
  const gasBar = document.getElementById('gas-progress');
  const gasBadge = document.getElementById('gas-status-badge');
  
  // Calculate percentage for progress bar (clamped 0 to 10000 PPM)
  const gasPercent = Math.min(100, Math.max(0, (gasPpm / 10000) * 100));
  gasBar.style.width = `${gasPercent}%`;

  if (gasPpm < 800) {
    gasBadge.className = "badge badge-success";
    gasBadge.textContent = "Clean Air";
    gasBar.className = "progress-bar bar-success";
  } else if (gasPpm < 2500) {
    gasBadge.className = "badge badge-warning";
    gasBadge.textContent = "Gas Detected / Warning";
    gasBar.className = "progress-bar bar-warning";
  } else {
    gasBadge.className = "badge badge-danger";
    gasBadge.textContent = "TOXIC / ALCOHOL ALERT";
    gasBar.className = "progress-bar bar-danger";
  }

  // 3. GPS Coordinates & Map
  if (data.gps && data.gps.valid) {
    const lat = parseFloat(data.gps.lat);
    const lng = parseFloat(data.gps.lng);
    document.getElementById('coord-lat').textContent = lat.toFixed(6);
    document.getElementById('coord-lng').textContent = lng.toFixed(6);
    
    // TinyGPS speed is reported in knots or raw, mapping it to display
    const speed = data.speed_kmh !== undefined ? data.speed_kmh : 0.0;
    document.getElementById('gps-speed').textContent = `${parseFloat(speed).toFixed(1)} km/h`;

    // Move map and marker
    if (map && riderMarker) {
      const newPos = [lat, lng];
      riderMarker.setLatLng(newPos);
      // Auto pan to coordinate if not actively dragging
      if (!map.matchesProperty) {
        map.panTo(newPos);
      }
    }
    
    lastGpsTimestamp = data.gps.timestamp || Date.now();
  }

  // 4. Staleness check
  checkGpsStaleness();

  // 5. Accident Latching logic
  const isAccident = data.accident;
  const overlay = document.getElementById('accident-siren-overlay');
  const card = document.getElementById('accident-status-card');
  const cardIcon = document.getElementById('accident-indicator-icon');
  const cardDesc = document.getElementById('accident-status-desc');
  const cardDismissBtn = document.getElementById('card-dismiss-btn');

  if (isAccident) {
    overlay.classList.remove('hidden');
    card.className = "glass-panel card accident-card-alarm";
    cardIcon.className = "fa-solid fa-triangle-exclamation text-danger";
    cardDesc.innerHTML = "<strong>CRITICAL IMPACT DETECTED!</strong> Emergency alerts active.";
    cardDismissBtn.classList.remove('hidden');
    playSirenSound();
    
    // Run automated nearby hospitals search on accident if not done yet
    if (emergencyMarkers.length === 0 && data.gps && data.gps.valid) {
      findNearbyEmergency(parseFloat(data.gps.lat), parseFloat(data.gps.lng));
    }
  } else {
    overlay.classList.add('hidden');
    card.className = "glass-panel card accident-card-normal";
    cardIcon.className = "fa-solid fa-heart-pulse text-success";
    cardDesc.textContent = "All systems normal. MPU6050 monitoring active.";
    cardDismissBtn.classList.add('hidden');
    stopSirenSound();
  }
}

// Verify GPS Data staleness (>30 seconds since last valid coordinate update)
function checkGpsStaleness() {
  const stalenessBadge = document.getElementById('gps-staleness-badge');
  const now = Date.now();
  const timeDiff = (now - lastGpsTimestamp) / 1000;

  if (timeDiff > 30) {
    stalenessBadge.className = "badge badge-danger";
    stalenessBadge.textContent = `Stale Fix (${Math.floor(timeDiff)}s)`;
  } else {
    stalenessBadge.className = "badge badge-success";
    stalenessBadge.textContent = "Active Fix";
  }
}

// Fetch Nearby Hospitals & Police Stations centered around a coordinate
async function findNearbyEmergency(lat, lng) {
  const resultsContainer = document.getElementById('emergency-results');
  resultsContainer.innerHTML = `
    <div class="empty-results">
      <i class="fa-solid fa-spinner fa-spin text-primary" style="font-size: 28px;"></i>
      <p>Searching for nearby emergency services within 5km...</p>
    </div>
  `;

  // Clear existing markers from map
  emergencyMarkers.forEach(marker => map.removeLayer(marker));
  emergencyMarkers = [];

  try {
    const response = await fetch(`/api/nearby-emergency?lat=${lat}&lng=${lng}`);
    const services = await response.json();

    if (services.length === 0) {
      resultsContainer.innerHTML = `
        <div class="empty-results">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <p>No medical or police services located in this 5km radius.</p>
        </div>
      `;
      return;
    }

    resultsContainer.innerHTML = ''; // Clear spinner

    services.forEach(item => {
      const isHosp = item.type === 'Hospital';
      
      // Determine marker color (Red for hospitals, Blue for Police)
      const markerColor = isHosp ? '#ef4444' : '#3b82f6';
      const markerIconClass = isHosp ? 'fa-solid fa-hospital' : 'fa-solid fa-building-shield';
      
      const customIcon = L.divIcon({
        html: `<div style="background-color: ${markerColor}; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 0 10px ${markerColor}; font-size: 11px;"><i class="${markerIconClass}"></i></div>`,
        className: 'emergency-marker-icon',
        iconSize: [28, 28]
      });

      // Add marker to map
      const marker = L.marker([item.lat, item.lng], { icon: customIcon }).addTo(map);
      marker.bindPopup(`<b>${item.name}</b><br>${item.type}<br>Rating: ${item.rating}<br><a href="${item.directions_url}" target="_blank">Navigate</a>`);
      emergencyMarkers.push(marker);

      // Create Sidebar Item Card
      const itemCard = document.createElement('div');
      itemCard.className = 'help-item';
      itemCard.innerHTML = `
        <div class="help-item-header">
          <span class="help-item-title">${item.name}</span>
          <span class="help-item-type ${isHosp ? 'type-hospital' : 'type-police'}">${item.type}</span>
        </div>
        <div class="help-item-meta">
          <span class="help-item-rating"><i class="fa-solid fa-star"></i> ${item.rating}</span>
          <span class="help-item-addr">${item.address}</span>
        </div>
        <div class="help-item-actions">
          <span class="help-item-phone"><i class="fa-solid fa-phone"></i> ${item.phone}</span>
          <a href="${item.directions_url}" target="_blank" class="help-link">
            Get Directions <i class="fa-solid fa-chevron-right"></i>
          </a>
        </div>
      `;
      
      // Pan map on clicking sidebar item
      itemCard.addEventListener('click', () => {
        map.setView([item.lat, item.lng], 16);
        marker.openPopup();
      });

      resultsContainer.appendChild(itemCard);
    });

    // Fit map bounds to show all elements
    const group = new L.featureGroup([riderMarker, ...emergencyMarkers]);
    map.fitBounds(group.getBounds().pad(0.1));

  } catch (error) {
    console.error("[Help Finder] Fetch failed:", error);
    resultsContainer.innerHTML = `
      <div class="empty-results">
        <i class="fa-solid fa-circle-exclamation text-danger"></i>
        <p>Failed to query map directory. Check server logs or internet connection.</p>
      </div>
    `;
  }
}

// Trigger Manual SOS via SOS button click
async function triggerEmergencySOS() {
  let lat = 12.9716; // Fallback
  let lng = 77.5946;
  let source = "Smart Helmet Dashboard (Cached Location)";

  if (riderMarker) {
    const pos = riderMarker.getLatLng();
    lat = pos.lat;
    lng = pos.lng;
  }

  // Attempt to grab actual browser GPS coordinates for high accuracy
  if (navigator.geolocation) {
    resultsContainerLoadingSpinner();
    
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        lat = position.coords.latitude;
        lng = position.coords.longitude;
        source = "Rider Web Browser Geolocation";
        
        // Center mapping
        if (riderMarker) {
          riderMarker.setLatLng([lat, lng]);
          map.setView([lat, lng], 15);
        }
        
        await sendSOSPayload(lat, lng, source);
      },
      async (err) => {
        console.warn("[Browser Geolocation] Access denied/timeout. Using helmet telemetry location.", err.message);
        await sendSOSPayload(lat, lng, source);
      },
      { timeout: 7000, enableHighAccuracy: true }
    );
  } else {
    await sendSOSPayload(lat, lng, source);
  }
}

function resultsContainerLoadingSpinner() {
  const resultsContainer = document.getElementById('emergency-results');
  resultsContainer.innerHTML = `
    <div class="empty-results">
      <i class="fa-solid fa-location-crosshairs fa-spin text-danger" style="font-size: 28px;"></i>
      <p>Acquiring high-accuracy browser coordinates...</p>
    </div>
  `;
}

// Dispatches the SOS coordinates to server API for Twilio SMS dispatch
async function sendSOSPayload(lat, lng, source) {
  try {
    const res = await fetch('/api/sos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng, source })
    });
    const responseData = await res.json();
    console.log("[SOS Server Dispatch Response]:", responseData);
    
    // Find nearest services immediately
    findNearbyEmergency(lat, lng);
  } catch (err) {
    console.error("[SOS Dispatch Error]:", err.message);
  }
}

// Simulator Control triggers
function initSimulatorControls() {
  const gasSlider = document.getElementById('sim-gas-slider');
  const gasVal = document.getElementById('sim-gas-val');

  gasSlider.addEventListener('input', (e) => {
    const val = e.target.value;
    gasVal.textContent = `${val} PPM`;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "UPDATE_SIM_GAS",
        value: val
      }));
    }
  });

  // Presets configuration
  const presetBlr = document.getElementById('preset-blr');
  const presetNyc = document.getElementById('preset-nyc');
  const presetLon = document.getElementById('preset-lon');

  const updatePresetClass = (activeBtn) => {
    [presetBlr, presetNyc, presetLon].forEach(btn => btn.classList.remove('active'));
    activeBtn.classList.add('active');
  };

  presetBlr.addEventListener('click', () => {
    updatePresetClass(presetBlr);
    socket.send(JSON.stringify({ type: "SET_SIM_GPS", lat: 12.9716, lng: 77.5946 }));
  });

  presetNyc.addEventListener('click', () => {
    updatePresetClass(presetNyc);
    socket.send(JSON.stringify({ type: "SET_SIM_GPS", lat: 40.7128, lng: -74.0060 }));
  });

  presetLon.addEventListener('click', () => {
    updatePresetClass(presetLon);
    socket.send(JSON.stringify({ type: "SET_SIM_GPS", lat: 51.5074, lng: -0.1278 }));
  });

  // Impact crash test button
  const crashBtn = document.getElementById('sim-impact-btn');
  crashBtn.addEventListener('click', () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "TRIGGER_SIM_ACCIDENT" }));
    }
  });
}

// Cancel Alarm Events (false alarms)
function dismissAlarm() {
  // Stop sirens locally
  stopSirenSound();
  
  // Hide overlays
  document.getElementById('accident-siren-overlay').classList.add('hidden');
  
  // Update state card
  const card = document.getElementById('accident-status-card');
  card.className = "glass-panel card accident-card-normal";
  document.getElementById('accident-indicator-icon').className = "fa-solid fa-heart-pulse text-success";
  document.getElementById('accident-status-desc').textContent = "All systems normal. MPU6050 monitoring active.";
  document.getElementById('card-dismiss-btn').classList.add('hidden');
  
  // Notify server to override accident status
  // Note: Telemetry state on server will be reset on subsequent packets, but we force simulated state clear immediately
  // If hardware is sending real "true" accident data, this will override, but since it is hysteresis timed, we let it clear.
}

// Document Load Event
document.addEventListener('DOMContentLoaded', () => {
  // Initialize default location map (Bangalore)
  initMap(12.9716, 77.5946);
  
  // Initialize chart
  initIMUChart();
  
  // Initialize Socket connection
  connectWebSocket();
  
  // Initialize click handlers
  document.getElementById('sos-btn').addEventListener('click', triggerEmergencySOS);
  document.getElementById('dismiss-siren-btn').addEventListener('click', dismissAlarm);
  document.getElementById('card-dismiss-btn').addEventListener('click', dismissAlarm);
  
  // Initialize slider interactions
  initSimulatorControls();

  // Watch GPS Staleness every 5 seconds
  gpsStalenessTimer = setInterval(checkGpsStaleness, 5000);
});
