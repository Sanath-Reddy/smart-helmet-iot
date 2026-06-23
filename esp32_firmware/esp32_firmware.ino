/*
 * AEGIS SMART HELMET FIRMWARE (ESP32)
 * 
 * Hardware Pin Connections:
 * 1. MPU6050 (I2C):
 *    - VCC -> 3.3V
 *    - GND -> GND
 *    - SDA -> GPIO 21 (Default I2C SDA on ESP32)
 *    - SCL -> GPIO 22 (Default I2C SCL on ESP32)
 * 
 * 2. NEO-6M GPS Module (HardwareSerial2):
 *    - VCC -> 3.3V / 5V
 *    - GND -> GND
 *    - TXD -> GPIO 16 (ESP32 RX2 Pin)
 *    - RXD -> GPIO 17 (ESP32 TX2 Pin)
 * 
 * 3. MQ135 Gas Sensor (Analog ADC):
 *    - VCC -> 5V
 *    - GND -> GND
 *    - AOUT -> GPIO 34 (ADC1 channel, analog reading)
 * 
 * Required Arduino Libraries:
 * - Adafruit MPU6050 (by Adafruit)
 * - Adafruit Unified Sensor (by Adafruit)
 * - TinyGPS++ (by Mikal Hart)
 * - WebSockets (by Markus Sattler)
 * - ArduinoJson (by Benoit Blanchon)
 */

#include <WiFi.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <TinyGPS++.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ==========================================
// CONFIGURATION VARIABLES
// ==========================================
const char* ssid = "Sanath";          // Change to your WiFi Network Name
const char* password = "Sanath012";  // Change to your WiFi Password

const char* server_host = "172.23.128.125";    // Change to your backend server's IP address
const int server_port = 3000;                 // Server listening port (default 3000)

#define MQ135_PIN 34                          // MQ135 Analog Pin
#define ACCEL_THRESHOLD_G 4.5                 // Accident threshold in G's
#define ACCIDENT_LATCH_MS 8000                // Latch duration (8 seconds)
#define TELEMETRY_INTERVAL_MS 2000            // Send telemetry every 2 seconds
#define GPS_STALENESS_MS 30000                // GPS staleness timeout (30 seconds)

// ==========================================
// SYSTEM STATE OBJECTS
// ==========================================
Adafruit_MPU6050 mpu;
TinyGPSPlus gps;
WebSocketsClient webSocket;

// GPS Tracking variables
double gps_lat = 0.0;
double gps_lng = 0.0;
float gps_speed = 0.0;
bool gps_valid = false;
unsigned long last_valid_gps_time = 0;

// Accident Detection state
bool accident_detected = false;
unsigned long accident_latch_start = 0;
bool use_raw_i2c = false;

// Reconnection Timers with Exponential Backoff
unsigned long last_wifi_reconnect_attempt = 0;
unsigned long wifi_backoff_delay = 10000;       // Start at 10s (gives initial connection time)

unsigned long last_ws_reconnect_attempt = 0;
unsigned long ws_backoff_delay = 1000;         // Start at 1s
bool ws_connected = false;

// General Timing
unsigned long last_telemetry_time = 0;

// ==========================================
// OFFLINE TELEMETRY CIRCULAR BUFFER
// ==========================================
struct TelemetryFrame {
  float ax, ay, az;
  float gx, gy, gz;
  double lat, lng;
  float speed;
  bool gps_valid;
  int gas_ppm;
  bool accident;
  unsigned long timestamp; // Relative time reference on device
};

// Helper: Raw I2C reader for MPU6050 clone/alternative sensors
bool readRawIMU(sensors_event_t &a, sensors_event_t &g) {
  Wire.beginTransmission(0x68);
  Wire.write(0x3B); // starting register for Accel/Gyro data
  if (Wire.endTransmission(false) != 0) return false;
  
  if (Wire.requestFrom(0x68, 14) != 14) return false;

  int16_t raw_ax = (Wire.read() << 8) | Wire.read();
  int16_t raw_ay = (Wire.read() << 8) | Wire.read();
  int16_t raw_az = (Wire.read() << 8) | Wire.read();
  int16_t raw_temp = (Wire.read() << 8) | Wire.read();
  int16_t raw_gx = (Wire.read() << 8) | Wire.read();
  int16_t raw_gy = (Wire.read() << 8) | Wire.read();
  int16_t raw_gz = (Wire.read() << 8) | Wire.read();

  // Convert raw values to m/s^2 and rad/s
  // Accel sensitivity: +/- 8G maps to 4096 LSB/g
  a.acceleration.x = ((float)raw_ax / 4096.0) * 9.81;
  a.acceleration.y = ((float)raw_ay / 4096.0) * 9.81;
  a.acceleration.z = ((float)raw_az / 4096.0) * 9.81;

  // Gyro sensitivity: +/- 500 deg/s maps to 65.5 LSB/(deg/s). Convert to rad/s
  g.gyro.x = ((float)raw_gx / 65.5) * 0.0174533;
  g.gyro.y = ((float)raw_gy / 65.5) * 0.0174533;
  g.gyro.z = ((float)raw_gz / 65.5) * 0.0174533;

  return true;
}

#define BUFFER_SIZE 12
TelemetryFrame offlineBuffer[BUFFER_SIZE];
int bufferHead = 0;
int bufferTail = 0;
int bufferCount = 0;

// Store a packet in queue
void pushToBuffer(TelemetryFrame frame) {
  offlineBuffer[bufferHead] = frame;
  bufferHead = (bufferHead + 1) % BUFFER_SIZE;
  
  if (bufferCount < BUFFER_SIZE) {
    bufferCount++;
  } else {
    // Buffer overflow: drop oldest by advancing tail index
    bufferTail = (bufferTail + 1) % BUFFER_SIZE;
    Serial.println("[Buffer] Queue overflow, oldest frame overwritten.");
  }
  Serial.printf("[Buffer] Telemetry frame cached. Queue occupancy: %d/%d\n", bufferCount, BUFFER_SIZE);
}

// Retrieve oldest packet from queue
bool popFromBuffer(TelemetryFrame &frame) {
  if (bufferCount == 0) return false;
  frame = offlineBuffer[bufferTail];
  bufferTail = (bufferTail + 1) % BUFFER_SIZE;
  bufferCount--;
  return true;
}

// ==========================================
// SYSTEM INITIALIZATION
// ==========================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n--- AEGIS SMART HELMET CONTROLLER ---");

  // 1. Initialize MQ135 Pin
  pinMode(MQ135_PIN, INPUT);

  // 2. Initialize Neo-6M GPS on HardwareSerial2
  // Pins on ESP32: RX=16, TX=17
  Serial2.begin(9600, SERIAL_8N1, 16, 17);
  Serial.println("[GPS] Receiver online on RX2 (pin 16), TX2 (pin 17)");

  // 3. Initialize MPU6050
  Wire.begin();
  delay(100);
  
  // Quick WHO_AM_I test
  Wire.beginTransmission(0x68);
  Wire.write(0x75);
  Wire.endTransmission(false);
  Wire.requestFrom(0x68, 1);
  byte who_am_i = Wire.read();
  Serial.printf("[IMU Diagnostic] WHO_AM_I returned: 0x%02X\n", who_am_i);

  if (mpu.begin(0x68)) {
    Serial.println("[IMU] Adafruit MPU6050 library initialized successfully.");
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    use_raw_i2c = false;
  } else {
    Serial.println("[IMU Warning] Adafruit library init failed. Setting up raw I2C fallback mode...");
    
    // Manual Wake-up & Configuration
    Wire.beginTransmission(0x68);
    Wire.write(0x6B); // PWR_MGMT_1 register
    Wire.write(0x00); // Wake up
    Wire.endTransmission();
    delay(50);
    
    Wire.beginTransmission(0x68);
    Wire.write(0x1C); // ACCEL_CONFIG register
    Wire.write(0x10); // +/- 8G
    Wire.endTransmission();
    
    Wire.beginTransmission(0x68);
    Wire.write(0x1B); // GYRO_CONFIG register
    Wire.write(0x08); // +/- 500 deg/s
    Wire.endTransmission();
    
    use_raw_i2c = true;
    Serial.println("[IMU] Raw I2C configuration complete. Falling back to manual register reads.");
  }

  // 4. Connect WiFi
  initWiFi();

  // 5. Initialize WebSockets client
  initWebSocket();
}

// ==========================================
// WIFI & WEBSOCKET SETUP
// ==========================================
void initWiFi() {
  Serial.printf("[WiFi] Connecting to Network: %s\n", ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  
  // Note: Non-blocking WiFi connection is handled in loop, here we trigger initial request
}

void handleWiFiConnection() {
  if (WiFi.status() == WL_CONNECTED) {
    // Reset backoff once connected
    wifi_backoff_delay = 10000; 
    return;
  }

  unsigned long current_time = millis();
  if (current_time - last_wifi_reconnect_attempt >= wifi_backoff_delay) {
    last_wifi_reconnect_attempt = current_time;
    
    Serial.println("[WiFi] Connection disconnected. Retrying...");
    WiFi.disconnect();
    delay(100);
    WiFi.begin(ssid, password);
    
    // Exponential backoff scaling up to 120 seconds
    wifi_backoff_delay = min(wifi_backoff_delay * 2, 120000UL);
    Serial.printf("[WiFi] Reconnect retry backoff set to: %d seconds\n", wifi_backoff_delay / 1000);
  }
}

void initWebSocket() {
  webSocket.begin(server_host, server_port, "/esp32");
  webSocket.onEvent(webSocketEvent);
}

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] WebSocket connection disconnected.");
      ws_connected = false;
      break;
      
    case WStype_CONNECTED:
      Serial.println("[WS] WebSocket connection established!");
      ws_connected = true;
      ws_backoff_delay = 1000; // Reset websocket backoff on success
      
      // Flush offline buffers
      flushOfflineData();
      break;
      
    case WStype_TEXT:
      {
        Serial.printf("[WS] Received server payload: %s\n", payload);
        
        // Parse incoming commands from the backend server
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, payload);
        if (!error) {
          const char* commandType = doc["type"];
          if (commandType && strcmp(commandType, "RESET_ACCIDENT") == 0) {
            accident_detected = false;
            accident_latch_start = 0;
            Serial.println("[Alert Control] Accident alarm reset by server command!");
          }
        }
      }
      break;
      
    case WStype_ERROR:
      Serial.println("[WS] Socket error occurred.");
      break;
  }
}

void handleWebSocketConnection() {
  if (WiFi.status() != WL_CONNECTED) {
    ws_connected = false;
    return;
  }

  webSocket.loop();

  if (ws_connected) return;

  unsigned long current_time = millis();
  if (current_time - last_ws_reconnect_attempt >= ws_backoff_delay) {
    last_ws_reconnect_attempt = current_time;
    
    Serial.println("[WS] Attempting server connection handshake...");
    webSocket.begin(server_host, server_port, "/esp32");
    
    ws_backoff_delay = min(ws_backoff_delay * 2, 120000UL); // Scale up to 120s
    Serial.printf("[WS] Server reconnect backoff scaled: %d seconds\n", ws_backoff_delay / 1000);
  }
}

// ==========================================
// CORE SENSOR ROUTINES
// ==========================================
void readGPS() {
  // Feed characters to parser
  while (Serial2.available() > 0) {
    gps.encode(Serial2.read());
  }

  // Validate updates
  if (gps.location.isUpdated() && gps.location.isValid()) {
    gps_lat = gps.location.lat();
    gps_lng = gps.location.lng();
    gps_speed = gps.speed.kmph();
    gps_valid = true;
    last_valid_gps_time = millis();
  }

  // Check staleness timeout (30 seconds)
  if (gps_valid && (millis() - last_valid_gps_time > GPS_STALENESS_MS)) {
    gps_valid = false;
    Serial.println("[GPS Warning] GPS signal lost! Data marked as stale.");
  }
}

int readGasPPM() {
  int analogVal = analogRead(MQ135_PIN);
  
  // Linear scaling simulation mapping 0-4095 to 0-10,000 PPM
  float ppm = map(analogVal, 0, 4095, 0, 10000);
  return constrain((int)ppm, 0, 10000);
}

void checkAccident(sensors_event_t &a) {
  // Convert acceleration magnitudes from m/s^2 into standard Gravity G force:
  float ax_g = a.acceleration.x / 9.81;
  float ay_g = a.acceleration.y / 9.81;
  float az_g = a.acceleration.z / 9.81;

  float total_accel_g = sqrt(ax_g*ax_g + ay_g*ay_g + az_g*az_g);

  // Check collision threshold trigger
  if (total_accel_g >= ACCEL_THRESHOLD_G) {
    if (!accident_detected) {
      Serial.printf("[CRITICAL ALERT] Sudden Impact Detected: %.2f Gs!\n", total_accel_g);
      accident_detected = true;
      // Send WebSocket alert immediately, bypassing standard timer delay
      sendImmediateAccidentAlert();
    }
    accident_latch_start = millis(); // Refresh/reset latch timing window
  }

  // Hysteresis Latching: Reset latch after 8 seconds of normal forces
  if (accident_detected && (millis() - accident_latch_start >= ACCIDENT_LATCH_MS)) {
    if (total_accel_g < ACCEL_THRESHOLD_G) {
      accident_detected = false;
      Serial.println("[Alert Cleared] Impact latch time expired. System normal.");
    }
  }
}

// ==========================================
// TELEMETRY TRANSMISSION & BUFFERING
// ==========================================
TelemetryFrame compileCurrentFrame(sensors_event_t &a, sensors_event_t &g, int gasPpm) {
  TelemetryFrame frame;
  frame.ax = a.acceleration.x / 9.81;
  frame.ay = a.acceleration.y / 9.81;
  frame.az = a.acceleration.z / 9.81;
  frame.gx = g.gyro.x * 57.2958; // convert rad/s to deg/s
  frame.gy = g.gyro.y * 57.2958;
  frame.gz = g.gyro.z * 57.2958;
  frame.lat = gps_lat;
  frame.lng = gps_lng;
  frame.speed = gps_speed;
  frame.gps_valid = gps_valid;
  frame.gas_ppm = gasPpm;
  frame.accident = accident_detected;
  frame.timestamp = millis();
  return frame;
}

String serializeFrame(TelemetryFrame &frame) {
  JsonDocument doc;
  doc["device_id"] = "ESP32_HELMET_01";
  doc["accident"] = frame.accident;
  doc["gas_ppm"] = frame.gas_ppm;
  doc["speed_kmh"] = frame.speed;
  doc["buffered"] = (millis() - frame.timestamp > 1000); // Check if from historical logs

  doc["gps"]["lat"] = frame.lat;
  doc["gps"]["lng"] = frame.lng;
  doc["gps"]["valid"] = frame.gps_valid;
  doc["gps"]["stale"] = !frame.gps_valid;

  doc["mpu"]["ax"] = frame.ax;
  doc["mpu"]["ay"] = frame.ay;
  doc["mpu"]["az"] = frame.az;
  doc["mpu"]["gx"] = frame.gx;
  doc["mpu"]["gy"] = frame.gy;
  doc["mpu"]["gz"] = frame.gz;

  String output;
  serializeJson(doc, output);
  return output;
}

void processTelemetry(sensors_event_t &a, sensors_event_t &g, int gasPpm) {
  unsigned long current_time = millis();
  if (current_time - last_telemetry_time >= TELEMETRY_INTERVAL_MS) {
    last_telemetry_time = current_time;

    TelemetryFrame currentFrame = compileCurrentFrame(a, g, gasPpm);
    
    if (WiFi.status() == WL_CONNECTED && ws_connected) {
      // Direct stream
      String payload = serializeFrame(currentFrame);
      webSocket.sendTXT(payload);
    } else {
      // Connection offline: cache to circular memory
      pushToBuffer(currentFrame);
    }
  }
}

// Emergency WebSocket bypass
void sendImmediateAccidentAlert() {
  sensors_event_t a, g, temp;
  if (use_raw_i2c) {
    readRawIMU(a, g);
  } else {
    mpu.getEvent(&a, &g, &temp);
  }
  int gasPpm = readGasPPM();
  
  TelemetryFrame urgentFrame = compileCurrentFrame(a, g, gasPpm);
  urgentFrame.accident = true;
  
  if (WiFi.status() == WL_CONNECTED && ws_connected) {
    String payload = serializeFrame(urgentFrame);
    webSocket.sendTXT(payload);
    Serial.println("[WS Direct] Critical collision alert dispatched to server.");
  } else {
    pushToBuffer(urgentFrame);
  }
}

// Dispatches queued buffer packets sequentially upon network restoration
void flushOfflineData() {
  if (bufferCount == 0) return;
  
  Serial.printf("[Buffer] Restoring connectivity. Flushing %d telemetry entries...\n", bufferCount);
  TelemetryFrame oldFrame;
  
  while (popFromBuffer(oldFrame)) {
    if (WiFi.status() == WL_CONNECTED && ws_connected) {
      String payload = serializeFrame(oldFrame);
      webSocket.sendTXT(payload);
      delay(80); // Small delay to avoid network congestion spikes on reconnect
    } else {
      // Signal fell out midway, re-cache frame
      pushToBuffer(oldFrame);
      break;
    }
  }
  Serial.println("[Buffer] Buffers flushed successfully.");
}

// ==========================================
// CORE LOOP ROUTINE
// ==========================================
void loop() {
  // 1. Maintain Connection States (WiFi + Socket Client)
  handleWiFiConnection();
  handleWebSocketConnection();

  // 2. Read GPS Streams
  readGPS();

  // 3. Collect Sensor Streams
  sensors_event_t a, g, temp;
  if (use_raw_i2c) {
    readRawIMU(a, g);
  } else {
    mpu.getEvent(&a, &g, &temp);
  }
  int gasPpm = readGasPPM();

  // 4. Scan collision conditions
  checkAccident(a);

  // 5. Broadcast telemetry frames based on timers
  processTelemetry(a, g, gasPpm);
}
