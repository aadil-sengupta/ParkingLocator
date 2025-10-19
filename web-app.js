// ========== CONFIG ==========
const GOOGLE_MAPS_API_KEY = "AIzaSyAX5e_C12qVrkt1f5iRDnwWTX931KlomjI";

const STATUS_STYLES = {
  PAID: { color: '#ef4444', icon: 'P', label: 'Paid' },
  FREE: { color: '#22c55e', icon: '✓', label: 'Free' },
  TOW_AWAY: { color: '#f97316', icon: 'T', label: 'Tow-Away' },
  UNKNOWN: { color: '#6b7280', icon: '?', label: 'Unknown' }
};

// Parking meter data loaded from CSV files
let clustersData = [];
let membersData = [];
let clusterMap = new Map(); // cluster_id -> cluster data

// Color handling for meter caps
const KNOWN_CAP_COLORS = {
  grey: "#6b7280",
  gray: "#6b7280",
  silver: "#9ca3af",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  red: "#ef4444",
  black: "#111827",
  brown: "#92400e",
  orange: "#f97316",
  purple: "#8b5cf6",
  pink: "#ec4899",
  gold: "#f59e0b",
  white: "#d1d5db"
};

const FALLBACK_COLORS = [
  "#0ea5e9",
  "#f87171",
  "#a855f7",
  "#14b8a6",
  "#facc15",
  "#22d3ee",
  "#ef4444",
  "#84cc16"
];

let capColorAssignments = new Map();
let fallbackColorIndex = 0;

const MIN_ZOOM_FOR_METERS = 18;
const MIN_ZOOM_FOR_CLUSTERS = 12;
const MAX_METERS_PER_VIEW = 500;
const MAX_CLUSTERS_PER_VIEW = 200;
const VIEWPORT_PADDING_RATIO = 0.1;

let map, autocomplete, directionsService, directionsRenderer;
let destinationMarker = null;
let visibleMarkerMap = new Map();
let visibleClusterMap = new Map();
let nearestMarker = null;
let currentRoute = null;
let meterInfoWindow = null;
let selectedMeterData = null;
let clusterInfoWindow = null;
let zoomHintActive = false;
let lastLimitedTotal = 0;

// UI State
let isSidebarCollapsed = false;
let isMobilePanelExpanded = false;
let isMobileView = window.innerWidth <= 768;
let activeFilter = 'all'; // 'all', 'free', 'paid'

// Utility functions
function showWarning(msg, type = 'warning') {
  const el = document.getElementById('warning');
  el.textContent = msg;
  el.style.display = 'block';
  el.className = type === 'error' ? 'error' : 'warning';
  setTimeout(() => el.style.display = 'none', 5000);
}

function showLoading(buttonId, isLoading) {
  const btn = document.getElementById(buttonId);
  if (isLoading) {
    btn.innerHTML = '<span class="loading"></span>' + btn.textContent.replace(/🔍|📱|🧭/, '');
    btn.disabled = true;
  } else {
    btn.disabled = false;
    // Restore original text
    if (buttonId.includes('findParking')) btn.innerHTML = '🔍 Find Parking';
    else if (buttonId.includes('useLocation')) btn.innerHTML = '📱 My Location';
    else if (buttonId.includes('directions')) btn.innerHTML = '🧭 Directions';
  }
}

async function loadParkingData(forceRefresh = false) {
  try {
    const cacheBuster = forceRefresh ? `?t=${Date.now()}` : '';
    
    // Load both clusters and members
    const [clustersResponse, membersResponse] = await Promise.all([
      fetch(`clusters.csv${cacheBuster}`),
      fetch(`members.csv${cacheBuster}`)
    ]);

    if (!clustersResponse.ok) {
      throw new Error(`Failed to fetch clusters data: ${clustersResponse.status} ${clustersResponse.statusText}`);
    }
    if (!membersResponse.ok) {
      throw new Error(`Failed to fetch members data: ${membersResponse.status} ${membersResponse.statusText}`);
    }

    const [clustersText, membersText] = await Promise.all([
      clustersResponse.text(),
      membersResponse.text()
    ]);

    clustersData = parseCsv(clustersText)
      .filter(entry => Number.isFinite(parseFloat(entry.centroid_latitude)) && Number.isFinite(parseFloat(entry.centroid_longitude)))
      .filter(entry => !isMotorcycleParking(entry));
    
    membersData = parseCsv(membersText)
      .filter(entry => Number.isFinite(parseFloat(entry.latitude)) && Number.isFinite(parseFloat(entry.longitude)));

    // Build cluster lookup map
    clusterMap = new Map();
    clustersData.forEach(cluster => {
      clusterMap.set(cluster.cluster_id, cluster);
    });

    lastLimitedTotal = 0;

    if (!clustersData.length && !membersData.length) {
      showWarning('No parking meter data was found in the data sources.', 'error');
    }
  } catch (error) {
    console.error('Error loading parking data:', error);
    showWarning('Unable to load parking meter data. Please refresh or check the data files.', 'error');
    clustersData = [];
    membersData = [];
    clusterMap = new Map();
  }
}

function parseCsv(text) {
  if (!text) return [];

  const rows = text.trim().split(/\r?\n/);
  if (!rows.length) return [];

  const headers = splitCsvLine(rows.shift());
  const records = [];

  rows.forEach(line => {
    if (!line.trim()) return;
    const cells = splitCsvLine(line);
    const record = {};

    headers.forEach((header, index) => {
      const key = header.trim();
      const rawValue = cells[index] !== undefined ? cells[index] : '';
      record[key] = sanitizeCsvValue(rawValue);
    });

    const lat = parseFloat(record.latitude ?? record.Latitude ?? record.lat ?? record.Lat ?? '');
    const lng = parseFloat(record.longitude ?? record.Longitude ?? record.lng ?? record.Lng ?? '');
    const capColorRaw = record.cap_color ?? record.capColor ?? '';
    const capColorDisplay = capColorRaw && typeof capColorRaw === 'string' ? capColorRaw.trim() : '';

    // Handle cluster-specific fields
    if (record.centroid_latitude) {
      record.centroid_lat = parseFloat(record.centroid_latitude);
    }
    if (record.centroid_longitude) {
      record.centroid_lng = parseFloat(record.centroid_longitude);
    }
    if (record.schedule_json) {
      try {
        record.parsed_schedule = JSON.parse(record.schedule_json);
      } catch (e) {
        record.parsed_schedule = null;
      }
    }

    const capColorDisplaySafe = capColorDisplay || 'Unknown';
    const timeLimitRaw = record.time_limit_min ?? record.timeLimit ?? '';
    const timeLimitParsed = Number.parseInt(timeLimitRaw, 10);
    const timeLimit = Number.isFinite(timeLimitParsed) ? timeLimitParsed : null;

    if (!record.from_time && record.fromTime) {
      record.from_time = record.fromTime;
    }
    if (!record.to_time && record.toTime) {
      record.to_time = record.toTime;
    }
    if (!record.meter_state && record.meterState) {
      record.meter_state = record.meterState;
    }
    if (!record.active_meter_status && record.activeMeterStatus) {
      record.active_meter_status = record.activeMeterStatus;
    }
    if (!record.street_and_block && record.streetAndBlock) {
      record.street_and_block = record.streetAndBlock;
    }
    if (!record.block_side && record.blockSide) {
      record.block_side = record.blockSide;
    }
    if (!record.analysis_neighborhood && record.analysisNeighborhood) {
      record.analysis_neighborhood = record.analysisNeighborhood;
    }
    if (!record.meter_type && record.meterType) {
      record.meter_type = record.meterType;
    }
    if (!record.post_id && record.postId) {
      record.post_id = record.postId;
    }

    const daysValue = record.days ?? record.Days ?? '';

    records.push({
      ...record,
      lat,
      lng,
      capColorDisplay: capColorDisplaySafe,
      capColorKey: capColorDisplaySafe.toLowerCase(),
      days: formatDays(daysValue),
      time_limit_min: timeLimit
    });
  });

  return records;
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let insideQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      const nextChar = line[i + 1];
      if (insideQuotes && nextChar === '"') {
        current += '"';
        i += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

function sanitizeCsvValue(value) {
  if (value === undefined || value === null) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  const unquoted = trimmed.replace(/^"|"$/g, '').replace(/""/g, '"');
  return unquoted;
}

function formatDays(days) {
  if (!days) return '';
  return days.replace(/"/g, '').replace(/,/g, ', ');
}

function getMarkerColor(capColorDisplay) {
  const display = capColorDisplay && capColorDisplay.trim() ? capColorDisplay.trim() : 'Unknown';
  const key = display.toLowerCase();

  if (capColorAssignments.has(key)) {
    return capColorAssignments.get(key).color;
  }

  const knownColor = KNOWN_CAP_COLORS[key];
  const color = knownColor || FALLBACK_COLORS[fallbackColorIndex % FALLBACK_COLORS.length];
  if (!knownColor) {
    fallbackColorIndex += 1;
  }

  capColorAssignments.set(key, { displayName: display, color });
  return color;
}

function buildMeterInfoContent(data, refTime = new Date()) {
  const statusInfo = getCurrentStatus(data.cluster?.parsed_schedule, refTime);
  const location = formatMeterLocation(data);
  const scheduleHtml = data.cluster?.parsed_schedule 
    ? `<div class="meter-info-row"><strong>Schedule:</strong>${formatClusterSchedule(data.cluster.parsed_schedule, 'details')}</div>`
    : '';

  return `
    <div class="meter-info-window">
      <h4 class="meter-info-title">${formatMeterTitle(data)}</h4>
      <div class="meter-info-row">
        <span class="status-badge status-${statusInfo.status.toLowerCase()}">${statusInfo.status}</span>
        ${statusInfo.message}
      </div>
      <div class="meter-info-row"><strong>Location:</strong> ${location}</div>
      <div class="meter-info-row"><strong>Meter ID:</strong> ${data.post_id || 'N/A'}</div>
      <div class="meter-info-row"><strong>Cluster:</strong> ${data.cluster_id || 'N/A'}</div>
      ${scheduleHtml}
    </div>
  `;
}

function buildClusterInfoContent(cluster, refTime = new Date()) {
  const scheduleHtml = cluster.parsed_schedule 
    ? formatClusterSchedule(cluster.parsed_schedule, 'details')
    : 'Schedule not available';
  
  return `
    <div class="meter-info-window">
      <h4 class="meter-info-title">Parking Cluster: ${cluster.street_name_mode || 'Unknown'}</h4>
      <div class="meter-info-row"><strong>Cluster ID:</strong> ${cluster.cluster_id || 'N/A'}</div>
      <div class="meter-info-row"><strong>Meters:</strong> ${cluster.count_meters || 0}</div>
      <div class="meter-info-row"><strong>Cap Color:</strong> ${cluster.cap_color_mode || 'Unknown'}</div>
      <div class="meter-info-row"><strong>Street:</strong> ${cluster.street_name_mode || 'Unknown'}</div>
      <div class="meter-info-row"><strong>Schedule:</strong> ${scheduleHtml}</div>
      <div class="meter-info-row"><em>Click to zoom in for individual meters</em></div>
    </div>
  `;
}function updateColorKey() {
  const container = document.getElementById('colorKey');
  if (!container) return;

  container.innerHTML = '';

  const entries = Array.from(capColorAssignments.values());
  entries.sort((a, b) => a.displayName.localeCompare(b.displayName));

  entries.forEach(({ displayName, color }) => {
    const item = document.createElement('div');
    item.className = 'color-key-item';
    item.innerHTML = `
      <span class="color-swatch" style="background:${color}"></span>
      <span>${displayName}</span>
    `;
    container.appendChild(item);
  });

  if (!entries.length) {
    const emptyState = document.createElement('div');
    emptyState.className = 'color-key-empty';
    emptyState.textContent = 'Meter color data unavailable.';
    container.appendChild(emptyState);
  }
}

function formatMeterTitle(data) {
  if (data.street_name && data.street_num) {
    return `${data.street_num} ${data.street_name}`;
  }
  if (data.street_name) return data.street_name;
  return data.post_id ? `Meter ${data.post_id}` : 'Parking Meter';
}

function formatMeterLocation(data) {
  const parts = [data.street_num, data.street_name];
  const primary = parts.filter(Boolean).join(' ');
  if (primary) return primary;
  return 'Location details unavailable';
}

function formatBlockDetails(data) {
  if (data.blockface_id) {
    return data.blockface_id;
  }
  return 'Not specified';
}

function formatClusterSchedule(scheduleArray, format = 'summary') {
  if (!Array.isArray(scheduleArray) || !scheduleArray.length) {
    return 'No schedule available';
  }

  if (format === 'details') {
    const dayOrder = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
    const grouped = {};

    scheduleArray.forEach(rule => {
      const key = `${rule.from_time}-${rule.to_time}-${rule.meter_state}`;
      if (!grouped[key]) {
        grouped[key] = { ...rule, days: new Set() };
      }
      rule.days.split(',').forEach(day => grouped[key].days.add(day.trim()));
    });

    return Object.values(grouped)
      .map(rule => {
        const sortedDays = Array.from(rule.days).sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b));
        const days = sortedDays.join(', ');
        const limit = rule.time_limit_min ? ` (${rule.time_limit_min} min)` : '';
        const state = rule.meter_state || '';
        return `<div class="schedule-rule-line">${days}: ${rule.from_time} - ${rule.to_time} [${state}${limit}]</div>`;
      })
      .join('');
  }

  // Summary format
  return scheduleArray.map(sched => {
    const days = sched.days || '';
    const from = sched.from_time || '';
    const to = sched.to_time || '';
    const limit = sched.time_limit_min ? ` (${sched.time_limit_min} min limit)` : '';
    return `${days}: ${from}-${to}${limit}`;
  }).join('; ');
}

function formatScheduleRange(spot) {
  const days = spot.days || 'Schedule not posted';
  const start = spot.from_time || '—';
  const end = spot.to_time || '—';

  if (!spot.from_time && !spot.to_time) {
    return days;
  }

  return `${days} · ${start} - ${end}`;
}

function formatUserTimeRange(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return 'Not specified';
  }

  const timeOptions = { hour: 'numeric', minute: '2-digit' };
  const startTime = startDate.toLocaleTimeString([], timeOptions);
  const endTime = endDate.toLocaleTimeString([], timeOptions);
  const startDay = startDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const endDay = endDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  if (startDate.toDateString() === endDate.toDateString()) {
    return `${startDay} • ${startTime} - ${endTime}`;
  }

  return `${startDay} ${startTime} → ${endDay} ${endTime}`;
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function initMap() {
  try {
    map = new google.maps.Map(document.getElementById('map'), {
      center: { lat: 37.7876, lng: -122.3897 },
      zoom: 15,
      styles: [
        {
          featureType: "poi.business",
          elementType: "labels",
          stylers: [{ visibility: "off" }]
        },
        {
          featureType: "transit",
          elementType: "labels.icon",
          stylers: [{ visibility: "off" }]
        }
      ],
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      zoomControl: true,
      zoomControlOptions: {
        position: google.maps.ControlPosition.RIGHT_CENTER
      },
      gestureHandling: 'greedy'
    });

    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
      map,
      suppressMarkers: true,
      polylineOptions: {
        strokeColor: '#3b82f6',
        strokeWeight: 4,
        strokeOpacity: 0.8
      }
    });

    meterInfoWindow = new google.maps.InfoWindow();
    clusterInfoWindow = new google.maps.InfoWindow();

    await loadParkingData();
  renderMetersForViewport();
  map.addListener('idle', () => renderMetersForViewport());
    setupUI();
    initializeDateTime();
    handleResponsive();
  } catch (e) {
    showWarning('Google Maps failed to initialize. Check your API key and connection.', 'error');
    console.error(e);
  }
}

function setupUI() {
  // Desktop autocomplete
  const input = document.getElementById('destinationInput');
  
  try {
    autocomplete = new google.maps.places.Autocomplete(input, {
      fields: ['geometry', 'name', 'formatted_address'],
      componentRestrictions: { country: ['us'] }
    });
    autocomplete.bindTo('bounds', map);
  } catch (e) {
    console.warn('Places Autocomplete unavailable. Using geocoding fallback.');
  }

  // Mobile autocomplete
  if (isMobileView) {
    const mobileInput = document.getElementById('mobileDestinationInput');
    try {
      const mobileAutocomplete = new google.maps.places.Autocomplete(mobileInput, {
        fields: ['geometry', 'name', 'formatted_address'],
        componentRestrictions: { country: ['us'] }
      });
      mobileAutocomplete.bindTo('bounds', map);
    } catch (e) {
      console.warn('Mobile Places Autocomplete unavailable.');
    }
  }

  // Desktop event listeners
  document.getElementById('toggleSidebar')?.addEventListener('click', toggleSidebar);
  document.getElementById('findParkingBtn')?.addEventListener('click', () => findNearestParking(false));
  document.getElementById('useLocationBtn')?.addEventListener('click', () => useCurrentLocation(false));
  document.getElementById('resetBtn')?.addEventListener('click', () => resetAll(false));
  document.getElementById('directionsBtn')?.addEventListener('click', showDirections);
  document.getElementById('startTime').addEventListener('change', renderMetersForViewport);
  document.getElementById('endTime').addEventListener('change', renderMetersForViewport);
  
  // Desktop filter buttons
  document.getElementById('showAllBtn')?.addEventListener('click', () => setFilter('all', false));
  document.getElementById('showFreeBtn')?.addEventListener('click', () => setFilter('free', false));
  document.getElementById('showPaidBtn')?.addEventListener('click', () => setFilter('paid', false));

  // Mobile event listeners
  document.getElementById('mobileMenuBtn')?.addEventListener('click', toggleMobilePanel);
  document.getElementById('mobileFindParkingBtn')?.addEventListener('click', () => findNearestParking(true));
  document.getElementById('mobileUseLocationBtn')?.addEventListener('click', () => useCurrentLocation(true));
  document.getElementById('mobileResetBtn')?.addEventListener('click', () => resetAll(true));
  document.getElementById('mobileDirectionsBtn')?.addEventListener('click', showDirections);
  document.getElementById('mobileStartTime').addEventListener('change', renderMetersForViewport);
  document.getElementById('mobileEndTime').addEventListener('change', renderMetersForViewport);
  
  // Mobile filter buttons
  document.getElementById('mobileShowAllBtn')?.addEventListener('click', () => setFilter('all', true));
  document.getElementById('mobileShowFreeBtn')?.addEventListener('click', () => setFilter('free', true));
  document.getElementById('mobileShowPaidBtn')?.addEventListener('click', () => setFilter('paid', true));

  // Quick action buttons
  document.getElementById('locationBtn').addEventListener('click', () => useCurrentLocation(isMobileView));
  document.getElementById('refreshBtn').addEventListener('click', refreshParkingSpots);

  // Window resize handler
  window.addEventListener('resize', handleResponsive);
}

function handleResponsive() {
  const wasMobile = isMobileView;
  isMobileView = window.innerWidth <= 768;
  
  if (wasMobile !== isMobileView) {
    // Switched between mobile and desktop
    location.reload(); // Simple approach - reload to reinitialize properly
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById('controlPanel');
  isSidebarCollapsed = !isSidebarCollapsed;
  sidebar.classList.toggle('collapsed', isSidebarCollapsed);
}

function toggleMobilePanel() {
  const panel = document.getElementById('mobilePanel');
  isMobilePanelExpanded = !isMobilePanelExpanded;
  panel.classList.toggle('expanded', isMobilePanelExpanded);
}

function initializeDateTime() {
  const now = new Date();
  const startTime = new Date(now.getTime() + 10 * 60000);
  const endTime = new Date(startTime.getTime() + 2 * 60 * 60000);

  const startValue = startTime.toISOString().slice(0, 16);
  const endValue = endTime.toISOString().slice(0, 16);

  // Set for both desktop and mobile
  document.getElementById('startTime').value = startValue;
  document.getElementById('endTime').value = endValue;
  
  if (document.getElementById('mobileStartTime')) {
    document.getElementById('mobileStartTime').value = startValue;
    document.getElementById('mobileEndTime').value = endValue;
  }
}

function renderMetersForViewport() {
  if (!map) return;

  capColorAssignments = new Map();
  fallbackColorIndex = 0;

  const zoom = map.getZoom();
  if (typeof zoom !== 'number') return;

  // Clear existing markers
  clearVisibleMarkers();
  clearVisibleClusters();

  if (zoom < MIN_ZOOM_FOR_CLUSTERS) {
    updateColorKey();
    lastLimitedTotal = 0;
    if (!zoomHintActive) {
      showWarning(`Zoom in (≥ ${MIN_ZOOM_FOR_CLUSTERS}) to view parking clusters.`);
      zoomHintActive = true;
    }
    return;
  }

  if (zoomHintActive) {
    zoomHintActive = false;
  }

  const refTime = getReferenceTime();

  if (zoom >= MIN_ZOOM_FOR_METERS) {
    renderIndividualMeters(refTime);
  } else {
    renderClusterCentroids(refTime);
  }

  updateColorKey();
}

function isMotorcycleParking(cluster) {
  if (!cluster.parsed_schedule || !Array.isArray(cluster.parsed_schedule)) {
    return false;
  }
  
  return cluster.parsed_schedule.some(rule => {
    const meterState = (rule.meter_state || '').toLowerCase();
    return meterState.includes('motorcycle');
  });
}

function getReferenceTime() {
  const isMobile = window.innerWidth <= 768;
  const startTimeInput = document.getElementById(isMobile ? 'mobileStartTime' : 'startTime');
  const timeValue = startTimeInput.value;
  return timeValue ? new Date(timeValue) : new Date();
}

function setFilter(filterType, isMobile) {
  activeFilter = filterType;
  
  // Update button states for both desktop and mobile
  const prefixes = ['', 'mobile'];
  prefixes.forEach(prefix => {
    const allBtn = document.getElementById(`${prefix}${prefix ? 'S' : 's'}howAllBtn`);
    const freeBtn = document.getElementById(`${prefix}${prefix ? 'S' : 's'}howFreeBtn`);
    const paidBtn = document.getElementById(`${prefix}${prefix ? 'S' : 's'}howPaidBtn`);
    
    if (allBtn) allBtn.classList.toggle('active', filterType === 'all');
    if (freeBtn) freeBtn.classList.toggle('active', filterType === 'free');
    if (paidBtn) paidBtn.classList.toggle('active', filterType === 'paid');
  });
  
  // Re-render the map with the new filter
  renderMetersForViewport();
}

function shouldShowMarker(statusInfo) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'free') return statusInfo.status === 'FREE';
  if (activeFilter === 'paid') return statusInfo.status === 'PAID';
  return true;
}

function renderIndividualMeters(refTime = new Date()) {
  if (!Array.isArray(membersData) || !membersData.length) return;

  const bounds = map.getBounds();
  if (!bounds) return;

  const searchBounds = expandBounds(bounds, VIEWPORT_PADDING_RATIO);
  const center = map.getCenter();
  const centerPoint = center ? { lat: center.lat(), lng: center.lng() } : null;

  const candidates = [];
  let totalInBounds = 0;

  membersData.forEach(member => {
    const lat = parseFloat(member.latitude);
    const lng = parseFloat(member.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    
    const position = new google.maps.LatLng(lat, lng);
    if (searchBounds.contains(position)) {
      totalInBounds += 1;
      const distanceToCenter = centerPoint
        ? haversine(centerPoint, { lat, lng })
        : 0;
      candidates.push({ member, position, distanceToCenter, lat, lng });
    }
  });

  if (!candidates.length) {
    lastLimitedTotal = 0;
    return;
  }

  candidates.sort((a, b) => a.distanceToCenter - b.distanceToCenter);

  let limited = false;
  if (candidates.length > MAX_METERS_PER_VIEW) {
    candidates.length = MAX_METERS_PER_VIEW;
    limited = true;
  }

  if (limited && totalInBounds !== lastLimitedTotal) {
    showWarning(`Showing ${MAX_METERS_PER_VIEW} of ${totalInBounds} meters. Zoom in for more detail.`);
    lastLimitedTotal = totalInBounds;
  } else if (!limited) {
    lastLimitedTotal = 0;
  }

  const keepKeys = new Set();

  candidates.forEach(({ member, position, lat, lng }) => {
    const key = getMemberKey(member);
    const cluster = clusterMap.get(member.cluster_id);
    const statusInfo = getCurrentStatus(cluster?.parsed_schedule, refTime);
    
    // Apply filter
    if (!shouldShowMarker(statusInfo)) {
      return;
    }
    
    const style = STATUS_STYLES[statusInfo.status] || STATUS_STYLES.UNKNOWN;
    const icon = buildMeterIcon(style.color, style.icon);

    keepKeys.add(key);

    let marker = visibleMarkerMap.get(key);
    if (marker) {
      marker.setPosition(position);
      marker.setIcon(icon);
      marker.setTitle(`Meter ${member.post_id || ''} - ${statusInfo.label}`.trim());
    } else {
      marker = new google.maps.Marker({
        position,
        map,
        title: `Meter ${member.post_id || ''} - ${statusInfo.label}`.trim(),
        icon
      });
      marker.addListener('click', () => handleMeterClick(marker));
      visibleMarkerMap.set(key, marker);
    }

    // Enrich member data with cluster info
    marker.meterData = { ...member, lat, lng, cluster };
    if (!marker.getMap()) {
      marker.setMap(map);
    }
  });

  visibleMarkerMap.forEach((marker, key) => {
    if (!keepKeys.has(key)) {
      marker.setMap(null);
      visibleMarkerMap.delete(key);
    }
  });
}

function renderClusterCentroids(refTime = new Date()) {
  if (!Array.isArray(clustersData) || !clustersData.length) return;

  const bounds = map.getBounds();
  if (!bounds) return;

  const searchBounds = expandBounds(bounds, VIEWPORT_PADDING_RATIO);
  const center = map.getCenter();
  const centerPoint = center ? { lat: center.lat(), lng: center.lng() } : null;

  const candidates = [];
  let totalInBounds = 0;

  clustersData.forEach(cluster => {
    const lat = parseFloat(cluster.centroid_latitude);
    const lng = parseFloat(cluster.centroid_longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    
    const position = new google.maps.LatLng(lat, lng);
    if (searchBounds.contains(position)) {
      totalInBounds += 1;
      const distanceToCenter = centerPoint
        ? haversine(centerPoint, { lat, lng })
        : 0;
      candidates.push({ cluster, position, distanceToCenter, lat, lng });
    }
  });

  if (!candidates.length) {
    lastLimitedTotal = 0;
    return;
  }

  candidates.sort((a, b) => a.distanceToCenter - b.distanceToCenter);

  let limited = false;
  if (candidates.length > MAX_CLUSTERS_PER_VIEW) {
    candidates.length = MAX_CLUSTERS_PER_VIEW;
    limited = true;
  }

  if (limited && totalInBounds !== lastLimitedTotal) {
    showWarning(`Showing ${MAX_CLUSTERS_PER_VIEW} of ${totalInBounds} clusters. Zoom in for individual meters.`);
    lastLimitedTotal = totalInBounds;
  } else if (!limited) {
    lastLimitedTotal = 0;
  }

  const keepKeys = new Set();

  candidates.forEach(({ cluster, position, lat, lng }) => {
    const key = getClusterKey(cluster);
    const statusInfo = getCurrentStatus(cluster.parsed_schedule, refTime);
    
    // Apply filter
    if (!shouldShowMarker(statusInfo)) {
      return;
    }
    
    const style = STATUS_STYLES[statusInfo.status] || STATUS_STYLES.UNKNOWN;
    const icon = buildClusterIcon(style.color, parseInt(cluster.count_meters) || 1);

    keepKeys.add(key);

    let marker = visibleClusterMap.get(key);
    if (marker) {
      marker.setPosition(position);
      marker.setIcon(icon);
      marker.setTitle(`${cluster.count_meters} meters - ${cluster.street_name_mode || 'Unknown'} - ${statusInfo.label}`.trim());
    } else {
      marker = new google.maps.Marker({
        position,
        map,
        title: `${cluster.count_meters} meters - ${cluster.street_name_mode || 'Unknown'} - ${statusInfo.label}`.trim(),
        icon
      });
      marker.addListener('click', () => handleClusterClick(marker));
      visibleClusterMap.set(key, marker);
    }

    marker.clusterData = { ...cluster, lat, lng };
    if (!marker.getMap()) {
      marker.setMap(map);
    }
  });

  visibleClusterMap.forEach((marker, key) => {
    if (!keepKeys.has(key)) {
      marker.setMap(null);
      visibleClusterMap.delete(key);
    }
  });
}

function clearVisibleMarkers() {
  visibleMarkerMap.forEach(marker => marker.setMap(null));
  visibleMarkerMap.clear();
  if (meterInfoWindow) {
    meterInfoWindow.close();
  }
}

function clearVisibleClusters() {
  visibleClusterMap.forEach(marker => marker.setMap(null));
  visibleClusterMap.clear();
  if (clusterInfoWindow) {
    clusterInfoWindow.close();
  }
}

function expandBounds(bounds, ratio = 0.1) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();

  const latSpan = Math.max((ne.lat() - sw.lat()), 0.02);
  const lngSpan = Math.max((ne.lng() - sw.lng()), 0.02);

  const latPadding = latSpan * ratio;
  const lngPadding = lngSpan * ratio;

  const expanded = new google.maps.LatLngBounds(
    new google.maps.LatLng(sw.lat() - latPadding, sw.lng() - lngPadding),
    new google.maps.LatLng(ne.lat() + latPadding, ne.lng() + lngPadding)
  );

  return expanded;
}

function buildMeterIcon(color, label) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 8,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 2,
    labelOrigin: new google.maps.Point(0, 0.5)
  };
}

function buildClusterIcon(color, count) {
  const scale = Math.min(Math.max(10 + Math.log(count) * 2.5, 10), 22);
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: scale,
    fillColor: color,
    fillOpacity: 0.8,
    strokeColor: '#ffffff',
    strokeWeight: 3,
    label: {
      text: String(count),
      color: 'white',
      fontSize: `${Math.max(scale * 0.6, 9)}px`,
      fontWeight: 'bold',
    }
  };
}

function getMemberKey(member) {
  if (!member) return '';
  return member.post_id || member.blockface_id || `${member.latitude},${member.longitude}`;
}

function getClusterKey(cluster) {
  if (!cluster) return '';
  return cluster.cluster_id || `${cluster.centroid_latitude},${cluster.centroid_longitude}`;
}

function handleMeterClick(marker) {
  if (!marker) return;
  const data = marker.meterData;
  if (!data) return;

  const refTime = getReferenceTime();
  if (meterInfoWindow) {
    meterInfoWindow.setContent(buildMeterInfoContent(data, refTime));
    meterInfoWindow.open(map, marker);
  }

  let distanceToDestination = null;
  let walkMinutes = null;
  let destinationName = '';

  if (destinationMarker?.getPosition) {
    const destPos = destinationMarker.getPosition();
    if (destPos) {
      const destination = { lat: destPos.lat(), lng: destPos.lng() };
      distanceToDestination = haversine(destination, { lat: data.lat, lng: data.lng });
      walkMinutes = Math.ceil(distanceToDestination / 83.33);
      destinationName = destinationMarker.getTitle ? destinationMarker.getTitle() : destinationName;
    }
  }

  const isMobile = isMobileView;
  const startInput = document.getElementById(isMobile ? 'mobileStartTime' : 'startTime');
  const endInput = document.getElementById(isMobile ? 'mobileEndTime' : 'endTime');

  // Store the selected meter data for directions
  selectedMeterData = data;

  // Enable directions button if we have a destination
  const directionsBtn = document.getElementById(isMobile ? 'mobileDirectionsBtn' : 'directionsBtn');
  if (directionsBtn && destinationMarker) {
    directionsBtn.disabled = false;
  }

  displayParkingResults(data, {
    isMobile,
    distanceMeters: distanceToDestination,
    walkMinutes,
    destinationName,
    startTime: startInput?.value || null,
    endTime: endInput?.value || null
  });
}

function handleClusterClick(marker) {
  if (!marker) return;
  const cluster = marker.clusterData;
  if (!cluster) return;

  const refTime = getReferenceTime();
  if (clusterInfoWindow) {
    clusterInfoWindow.setContent(buildClusterInfoContent(cluster, refTime));
    clusterInfoWindow.open(map, marker);
  }

  // Zoom in to show individual meters
  const zoom = map.getZoom();
  if (zoom < MIN_ZOOM_FOR_METERS) {
    map.setCenter({ lat: cluster.lat, lng: cluster.lng });
    map.setZoom(MIN_ZOOM_FOR_METERS);
  }
}

function findNearestParking(isMobile = false) {
  const prefix = isMobile ? 'mobile' : '';
  const inputId = prefix + (prefix ? 'D' : 'd') + 'estinationInput';
  const startTimeId = prefix + (prefix ? 'S' : 's') + 'tartTime';
  const endTimeId = prefix + (prefix ? 'E' : 'e') + 'ndTime';
  const buttonId = prefix + (prefix ? 'F' : 'f') + 'indParkingBtn';

  const input = document.getElementById(inputId);
  const startTime = document.getElementById(startTimeId).value;
  const endTime = document.getElementById(endTimeId).value;

  if (!membersData.length) {
    showWarning('Parking meter data is still loading. Please try again in a moment.');
    return;
  }

  if (!input.value.trim()) {
    showWarning('Please enter a destination address.');
    return;
  }

  if (!startTime || !endTime) {
    showWarning('Please select start and end times for parking.');
    return;
  }

  showLoading(buttonId, true);

  // Use geocoding for simplicity in web version
  const geocoder = new google.maps.Geocoder();
  geocoder.geocode({ address: input.value }, (results, status) => {
    showLoading(buttonId, false);
    if (status === 'OK' && results[0]) {
      const loc = results[0].geometry.location;
      const destination = { lat: loc.lat(), lng: loc.lng() };
      processDestination(destination, results[0].formatted_address, startTime, endTime, isMobile);
    } else {
      showWarning('Could not find the destination address. Please try again.');
    }
  });
}

function processDestination(destination, destinationName, startTime, endTime, isMobile = false) {
  // Clear previous selections
  selectedMeterData = null;
  
  // Place destination marker
  if (destinationMarker) destinationMarker.setMap(null);
  destinationMarker = new google.maps.Marker({
    position: destination,
    map,
    title: destinationName,
    icon: {
      url: 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png',
      scaledSize: new google.maps.Size(40, 40)
    }
  });

  // Find nearest available parking spot
  let bestSpot = null;
  let bestDistance = Infinity;

  membersData.forEach(member => {
    const lat = parseFloat(member.latitude);
    const lng = parseFloat(member.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const distance = haversine(destination, { lat, lng });
    if (distance < bestDistance) {
      const cluster = clusterMap.get(member.cluster_id);
      bestSpot = { ...member, lat, lng, cluster };
      bestDistance = distance;
    }
  });

  if (!bestSpot) {
    showWarning('No parking meters found near your destination.');
    return;
  }

  if (meterInfoWindow) {
    meterInfoWindow.close();
  }

  // Highlight the nearest spot
  if (nearestMarker) nearestMarker.setMap(null);
  nearestMarker = new google.maps.Marker({
    position: { lat: bestSpot.lat, lng: bestSpot.lng },
    map,
    title: `Recommended meter ${bestSpot.post_id || ''}`.trim(),
    icon: {
      url: 'https://maps.google.com/mapfiles/kml/paddle/ylw-stars.png',
      scaledSize: new google.maps.Size(50, 50)
    }
  });

  const walkMinutes = Math.ceil(bestDistance / 83.33);
  nearestMarker.meterData = bestSpot;
  nearestMarker.addListener('click', () => handleMeterClick(nearestMarker));

  const focusBounds = new google.maps.LatLngBounds();
  focusBounds.extend(destination);
  focusBounds.extend({ lat: bestSpot.lat, lng: bestSpot.lng });
  map.fitBounds(focusBounds);
  if (map.getZoom() > 18) {
    map.setZoom(18);
  }

  // Show results
  displayParkingResults(bestSpot, {
    distanceMeters: bestDistance,
    walkMinutes,
    destinationName,
    isMobile,
    startTime,
    endTime
  });
  
  // Get directions
  getDirections(bestSpot, destination, destinationName, isMobile);
  
  // Enable directions button
  const directionsBtn = document.getElementById(isMobile ? 'mobileDirectionsBtn' : 'directionsBtn');
  if (directionsBtn) directionsBtn.disabled = false;
}

function displayParkingResults(spot, options = {}) {
  const {
    isMobile = false,
    distanceMeters = null,
    walkMinutes = null,
    destinationName = '',
    startTime = null,
    endTime = null
  } = options;

  const resultsPanel = document.getElementById(isMobile ? 'mobileResultsPanel' : 'resultsPanel');
  const parkingDetails = document.getElementById(isMobile ? 'mobileParkingDetails' : 'parkingDetails');
  const routeDetails = document.getElementById(isMobile ? 'mobileRouteDetails' : 'routeDetails');

  const refTime = getReferenceTime();
  const statusInfo = getCurrentStatus(spot.cluster?.parsed_schedule, refTime);

  const distanceInfo = (() => {
    if (distanceMeters === null) return '';
    const meters = Math.round(distanceMeters);
    const feet = Math.round(distanceMeters * 3.28084);
    return `<p><strong>Distance to ${destinationName || 'destination'}:</strong> ${meters} m (${feet} ft)</p>`;
  })();

  const walkInfo = walkMinutes !== null ? `<p><strong>Estimated walk:</strong> ~${walkMinutes} minutes</p>` : '';
  const userSchedule = (startTime && endTime)
    ? `<p><strong>Your parking window:</strong> ${formatUserTimeRange(startTime, endTime)}</p>`
    : '';

  const schedule = spot.cluster?.parsed_schedule 
    ? formatClusterSchedule(spot.cluster.parsed_schedule)
    : 'Schedule not available';

  parkingDetails.innerHTML = `
    <div class="parking-info">
      <h3>�️ ${formatMeterTitle(spot)}</h3>
      <p><strong>Meter ID:</strong> ${spot.post_id || 'N/A'}</p>
      <p><strong>Location:</strong> ${formatMeterLocation(spot)}</p>
  <p><strong>Block:</strong> ${formatBlockDetails(spot)}</p>
      <p><strong>Cap Color:</strong> ${spot.cap_color || 'Unknown'}</p>
      <p><strong>Meter State:</strong> ${spot.meter_state || 'Unknown'}</p>
      <p><strong>Status:</strong> ${spot.active_meter_status || 'Unknown'}</p>
      <p><strong>Schedule:</strong> ${schedule}</p>
      <p><strong>Time Limit:</strong> ${spot.time_limit_min ? `${spot.time_limit_min} minutes` : 'Not posted'}</p>
      <p><strong>Rule:</strong> ${spot.applied_rule || 'N/A'}</p>
      <p><strong>Meter Type:</strong> ${spot.meter_type || 'N/A'}</p>
      <p><strong>Neighborhood:</strong> ${spot.analysis_neighborhood || 'N/A'}</p>
      ${distanceInfo}
      ${walkInfo}
      ${userSchedule}
    </div>
  `;

  resultsPanel.classList.add('show');

  if (routeDetails && distanceMeters === null) {
    routeDetails.innerHTML = '';
  }

  if (isMobile && !isMobilePanelExpanded) {
    toggleMobilePanel();
  }
}

function getDirections(parkingSpot, destination, destinationName, isMobile = false) {
  directionsService.route({
    origin: { lat: parkingSpot.lat, lng: parkingSpot.lng },
    destination: destination,
    travelMode: google.maps.TravelMode.WALKING
  }, (result, status) => {
    if (status === 'OK') {
      currentRoute = result;
      const leg = result.routes[0].legs[0];
      
      const routeDetails = document.getElementById(isMobile ? 'mobileRouteDetails' : 'routeDetails');
      routeDetails.innerHTML = `
        <div class="result-item">
          <div class="result-label">🚶‍♂️ Walking Route</div>
          <div class="result-value">${leg.distance.text} • ${leg.duration.text}</div>
        </div>
      `;
    } else {
      console.warn('Directions request failed:', status);
    }
  });
}

function showDirections() {
  if (!selectedMeterData || !destinationMarker) {
    showWarning('Please select a destination and a parking meter first.', 'error');
    return;
  }

  const destPosition = destinationMarker.getPosition();
  if (!destPosition) {
    showWarning('Destination location not available.', 'error');
    return;
  }

  const origin = { lat: destPosition.lat(), lng: destPosition.lng() };
  const destination = { lat: selectedMeterData.lat, lng: selectedMeterData.lng };

  directionsService.route({
    origin: origin,
    destination: destination,
    travelMode: google.maps.TravelMode.WALKING
  }, (result, status) => {
    if (status === 'OK') {
      currentRoute = result;
      directionsRenderer.setDirections(result);
      map.fitBounds(result.routes[0].bounds);
      
      const leg = result.routes[0].legs[0];
      showWarning(`Walking directions: ${leg.distance.text} • ${leg.duration.text}`);
    } else {
      console.warn('Directions request failed:', status);
      showWarning('Could not get directions. Please try again.', 'error');
    }
  });
}

function useCurrentLocation(isMobile = false) {
  if (!navigator.geolocation) {
    showWarning('Geolocation is not supported by your browser.');
    return;
  }

  const buttonId = isMobile ? 'mobileUseLocationBtn' : 'useLocationBtn';
  showLoading(buttonId, true);
  
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const location = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      };
      
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ location }, (results, status) => {
        showLoading(buttonId, false);
        
        const inputId = isMobile ? 'mobileDestinationInput' : 'destinationInput';
        const input = document.getElementById(inputId);
        
        if (status === 'OK' && results[0]) {
          input.value = results[0].formatted_address;
          map.setCenter(location);
          map.setZoom(16);
        } else {
          input.value = `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
        }
      });
    },
    (error) => {
      const buttonId = isMobile ? 'mobileUseLocationBtn' : 'useLocationBtn';
      showLoading(buttonId, false);
      showWarning('Could not get your location: ' + error.message);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function refreshParkingSpots() {
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.style.transform = 'rotate(360deg)';

  try {
    await loadParkingData(true);
    renderMetersForViewport();
    showWarning('Parking meter data refreshed.');
  } catch (error) {
    console.error('Refresh failed:', error);
    showWarning('Failed to refresh parking meter data.', 'error');
  } finally {
    setTimeout(() => {
      refreshBtn.style.transform = 'rotate(0deg)';
    }, 600);
  }
}

function resetAll(isMobile = false) {
  // Clear map markers
  if (destinationMarker) {
    destinationMarker.setMap(null);
    destinationMarker = null;
  }
  if (nearestMarker) {
    nearestMarker.setMap(null);
    nearestMarker = null;
  }
  if (meterInfoWindow) {
    meterInfoWindow.close();
  }
  
  // Clear directions and selected meter
  directionsRenderer.set('directions', null);
  currentRoute = null;
  selectedMeterData = null;
  
  // Reset forms
  const prefix = isMobile ? 'mobile' : '';
  const inputId = prefix + (prefix ? 'D' : 'd') + 'estinationInput';
  const resultsId = prefix + (prefix ? 'R' : 'r') + 'esultsPanel';
  const directionsId = prefix + (prefix ? 'D' : 'd') + 'irectionsBtn';
  
  document.getElementById(inputId).value = '';
  document.getElementById(resultsId).classList.remove('show');
  document.getElementById(directionsId).disabled = true;
  
  // Hide warnings
  document.getElementById('warning').style.display = 'none';
  
  // Reset map view
  if (visibleMarkerMap.size || visibleClusterMap.size) {
    const bounds = new google.maps.LatLngBounds();
    let hasPosition = false;
    
    visibleMarkerMap.forEach(marker => {
      if (typeof marker.getPosition === 'function') {
        const pos = marker.getPosition();
        if (pos) {
          bounds.extend(pos);
          hasPosition = true;
        }
      }
    });
    
    visibleClusterMap.forEach(marker => {
      if (typeof marker.getPosition === 'function') {
        const pos = marker.getPosition();
        if (pos) {
          bounds.extend(pos);
          hasPosition = true;
        }
      }
    });
    
    if (hasPosition && !bounds.isEmpty()) {
      map.fitBounds(bounds);
      if (map.getZoom() < MIN_ZOOM_FOR_CLUSTERS) {
        map.setZoom(MIN_ZOOM_FOR_CLUSTERS);
      }
    }
  } else if (membersData.length || clustersData.length) {
    const firstMember = membersData.find(entry => Number.isFinite(parseFloat(entry.latitude)) && Number.isFinite(parseFloat(entry.longitude)));
    const firstCluster = clustersData.find(entry => Number.isFinite(parseFloat(entry.centroid_latitude)) && Number.isFinite(parseFloat(entry.centroid_longitude)));
    
    if (firstMember) {
      map.setCenter({ lat: parseFloat(firstMember.latitude), lng: parseFloat(firstMember.longitude) });
      map.setZoom(MIN_ZOOM_FOR_METERS);
    } else if (firstCluster) {
      map.setCenter({ lat: parseFloat(firstCluster.centroid_latitude), lng: parseFloat(firstCluster.centroid_longitude) });
      map.setZoom(MIN_ZOOM_FOR_CLUSTERS);
    }
  }

  renderMetersForViewport();
  
  initializeDateTime();
}

// Load Google Maps API
(function loadGoogleMaps() {
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}&libraries=places&callback=initMap`;
  script.async = true;
  script.defer = true;
  script.onerror = () => showWarning('Failed to load Google Maps. Check your API key and connection.', 'error');
  document.head.appendChild(script);
})();