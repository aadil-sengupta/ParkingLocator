// ========== CONFIG ==========
const GOOGLE_MAPS_API_KEY = "AIzaSyB7xkjnU8eFJhZ3G45_Wa6-QHay6XoGQYQ"; // user's key inserted

// Parking spots data (enhanced with additional info)
const PARKING_SPOTS = [
  { lat: 37.787611, lng: -122.389694, label: "Downtown Parking - Zone A", status: "available", hourlyRate: 4.50 },
  { lat: 37.78714973847698, lng: -122.38895764131333, label: "Street Parking - Pine St", status: "available", hourlyRate: 3.00 },
  { lat: 37.78798284272779, lng: -122.3903752246279, label: "Public Garage - Level 1", status: "available", hourlyRate: 5.00 },
  { lat: 37.787575251559176, lng: -122.39086373371947, label: "Meter Parking - Bush St", status: "available", hourlyRate: 2.50 },
  { lat: 37.78824549674944, lng: -122.39015348697146, label: "Parking Lot - Commercial", status: "available", hourlyRate: 6.00 },
  { lat: 37.788693190606075, lng: -122.38951781636143, label: "Street Parking - Stockton", status: "available", hourlyRate: 3.50 },
  { lat: 37.78856250562458, lng: -122.39268586605012, label: "Garage - Union Square", status: "available", hourlyRate: 7.00 },
  { lat: 37.78823813516505, lng: -122.39228924675083, label: "Surface Lot - Powell St", status: "available", hourlyRate: 4.00 },
  { lat: 37.78797290964031, lng: -122.3919625291102, label: "Street Parking - Geary", status: "available", hourlyRate: 2.75 },
  { lat: 37.787773412217476, lng: -122.39175451227223, label: "Meter Zone - Post St", status: "available", hourlyRate: 3.25 },
  { lat: 37.7875636094676, lng: -122.39148822788431, label: "Parking Structure - Sutter", status: "available", hourlyRate: 5.50 },
  { lat: 37.7872310969264, lng: -122.39104359812214, label: "Street Parking - Grant Ave", status: "available", hourlyRate: 3.00 },
  { lat: 37.78679959143184, lng: -122.39043528822279, label: "Public Lot - Chinatown", status: "available", hourlyRate: 4.25 },
  { lat: 37.78635273681646, lng: -122.3899559030742, label: "Garage - Financial District", status: "available", hourlyRate: 8.00 },
  { lat: 37.78677162951609, lng: -122.39043918674045, label: "Surface Parking - Kearny", status: "available", hourlyRate: 3.75 }
];

let map, autocomplete, directionsService, directionsRenderer;
let destinationMarker = null;
let parkingMarkers = [];
let nearestMarker = null;
let currentRoute = null;

// UI State
let isPanelExpanded = false;

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
    if (buttonId === 'findParkingBtn') btn.innerHTML = '🔍 Find Parking';
    else if (buttonId === 'useLocationBtn') btn.innerHTML = '📱 My Location';
    else if (buttonId === 'directionsBtn') btn.innerHTML = '🧭 Directions';
  }
}

function haversine(a, b) {
  const R = 6371000; // Earth's radius in meters
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function calculateParkingCost(hourlyRate, startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const hours = Math.ceil((end - start) / (1000 * 60 * 60));
  return { hours, cost: (hours * hourlyRate).toFixed(2) };
}

function initMap() {
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
        strokeColor: '#667eea',
        strokeWeight: 4,
        strokeOpacity: 0.8
      }
    });

    placeParkingSpots();
    setupUI();
    initializeDateTime();
  } catch (e) {
    showWarning('Google Maps failed to initialize. Check your API key and connection.', 'error');
    console.error(e);
  }
}

function setupUI() {
  const input = document.getElementById('destinationInput');
  
  // Setup autocomplete if available
  try {
    autocomplete = new google.maps.places.Autocomplete(input, {
      fields: ['geometry', 'name', 'formatted_address'],
      componentRestrictions: { country: ['us'] }
    });
    autocomplete.bindTo('bounds', map);
  } catch (e) {
    console.warn('Places Autocomplete unavailable. Using geocoding fallback.');
  }

  // Panel toggle
  document.getElementById('panelHeader').addEventListener('click', togglePanel);

  // Main action buttons
  document.getElementById('findParkingBtn').addEventListener('click', findNearestParking);
  document.getElementById('useLocationBtn').addEventListener('click', useCurrentLocation);
  document.getElementById('resetBtn').addEventListener('click', resetAll);
  document.getElementById('directionsBtn').addEventListener('click', showDirections);

  // Quick action buttons
  document.getElementById('locationBtn').addEventListener('click', useCurrentLocation);
  document.getElementById('refreshBtn').addEventListener('click', refreshParkingSpots);

  // Auto-expand panel when typing
  input.addEventListener('focus', () => {
    if (!isPanelExpanded) togglePanel();
  });
}

function initializeDateTime() {
  const now = new Date();
  const startTime = new Date(now.getTime() + 10 * 60000); // 10 minutes from now
  const endTime = new Date(startTime.getTime() + 2 * 60 * 60000); // 2 hours later

  document.getElementById('startTime').value = startTime.toISOString().slice(0, 16);
  document.getElementById('endTime').value = endTime.toISOString().slice(0, 16);
}

function togglePanel() {
  const panel = document.getElementById('controlPanel');
  isPanelExpanded = !isPanelExpanded;
  panel.classList.toggle('expanded', isPanelExpanded);
}

function placeParkingSpots() {
  const bounds = new google.maps.LatLngBounds();
  
  PARKING_SPOTS.forEach((spot, idx) => {
    const marker = new google.maps.Marker({
      position: { lat: spot.lat, lng: spot.lng },
      map,
      title: `${spot.label}\n$${spot.hourlyRate}/hour`,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: spot.status === 'available' ? '#10b981' : '#ef4444',
        fillOpacity: 0.9,
        strokeColor: '#ffffff',
        strokeWeight: 2
      }
    });

    // Info window for parking spots
    const infoWindow = new google.maps.InfoWindow({
      content: `
        <div style="padding: 8px;">
          <h4 style="margin: 0 0 8px 0; color: #1f2937;">${spot.label}</h4>
          <p style="margin: 4px 0; color: #6b7280;">
            <span class="status-dot status-${spot.status}"></span>
            Status: ${spot.status.charAt(0).toUpperCase() + spot.status.slice(1)}
          </p>
          <p style="margin: 4px 0; color: #6b7280;">Rate: $${spot.hourlyRate}/hour</p>
        </div>
      `
    });

    marker.addListener('click', () => {
      infoWindow.open(map, marker);
    });

    parkingMarkers.push(marker);
    bounds.extend(marker.getPosition());
  });

  map.fitBounds(bounds);
}

function findNearestParking() {
  const input = document.getElementById('destinationInput');
  const startTime = document.getElementById('startTime').value;
  const endTime = document.getElementById('endTime').value;

  if (!input.value.trim()) {
    showWarning('Please enter a destination address.');
    return;
  }

  if (!startTime || !endTime) {
    showWarning('Please select start and end times for parking.');
    return;
  }

  showLoading('findParkingBtn', true);

  const place = autocomplete && autocomplete.getPlace ? autocomplete.getPlace() : null;
  
  if (place && place.geometry) {
    const destination = {
      lat: place.geometry.location.lat(),
      lng: place.geometry.location.lng()
    };
    processDestination(destination, place.formatted_address || place.name, startTime, endTime);
  } else {
    // Fallback to geocoding
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: input.value }, (results, status) => {
      showLoading('findParkingBtn', false);
      if (status === 'OK' && results[0]) {
        const loc = results[0].geometry.location;
        const destination = { lat: loc.lat(), lng: loc.lng() };
        processDestination(destination, results[0].formatted_address, startTime, endTime);
      } else {
        showWarning('Could not find the destination address. Please try again.');
      }
    });
  }
}

function processDestination(destination, destinationName, startTime, endTime) {
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
  let bestIndex = -1;

  PARKING_SPOTS.forEach((spot, idx) => {
    if (spot.status === 'available') {
      const distance = haversine(destination, spot);
      if (distance < bestDistance) {
        bestSpot = spot;
        bestDistance = distance;
        bestIndex = idx;
      }
    }
  });

  if (!bestSpot) {
    showWarning('No available parking spots found near your destination.');
    showLoading('findParkingBtn', false);
    return;
  }

  // Highlight the nearest spot
  if (nearestMarker) nearestMarker.setMap(null);
  nearestMarker = new google.maps.Marker({
    position: { lat: bestSpot.lat, lng: bestSpot.lng },
    map,
    title: `Recommended: ${bestSpot.label}`,
    icon: {
      url: 'https://maps.google.com/mapfiles/kml/paddle/ylw-stars.png',
      scaledSize: new google.maps.Size(50, 50)
    }
  });

  // Calculate cost
  const { hours, cost } = calculateParkingCost(bestSpot.hourlyRate, startTime, endTime);

  // Show results
  displayParkingResults(bestSpot, bestDistance, hours, cost, destinationName);
  
  // Get driving directions
  getDirections(bestSpot, destination, destinationName);
  
  showLoading('findParkingBtn', false);
  document.getElementById('directionsBtn').disabled = false;
}

function displayParkingResults(spot, distance, hours, cost, destinationName) {
  const resultsPanel = document.getElementById('resultsPanel');
  const parkingDetails = document.getElementById('parkingDetails');
  
  const meters = Math.round(distance);
  const feet = Math.round(distance * 3.28084);
  const walkTime = Math.ceil(distance / 83.33); // Average walking speed ~5 km/h

  parkingDetails.innerHTML = `
    <div class="parking-info">
      <h3>🎯 ${spot.label}</h3>
      <p><strong>Distance:</strong> ${meters}m (${feet}ft) from destination</p>
      <p><strong>Walk time:</strong> ~${walkTime} minutes</p>
      <p><strong>Rate:</strong> $${spot.hourlyRate}/hour</p>
      <p><strong>Duration:</strong> ${hours} hours</p>
      <p><strong>Total cost:</strong> $${cost}</p>
    </div>
  `;

  resultsPanel.classList.add('show');
  
  // Expand panel if not already expanded
  if (!isPanelExpanded) togglePanel();
}

function getDirections(parkingSpot, destination, destinationName) {
  directionsService.route({
    origin: { lat: parkingSpot.lat, lng: parkingSpot.lng },
    destination: destination,
    travelMode: google.maps.TravelMode.WALKING
  }, (result, status) => {
    if (status === 'OK') {
      currentRoute = result;
      const leg = result.routes[0].legs[0];
      
      document.getElementById('routeDetails').innerHTML = `
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
  if (currentRoute) {
    directionsRenderer.setDirections(currentRoute);
    map.fitBounds(currentRoute.routes[0].bounds);
    showWarning('Walking directions displayed on map.', 'info');
  }
}

function useCurrentLocation() {
  if (!navigator.geolocation) {
    showWarning('Geolocation is not supported by your browser.');
    return;
  }

  showLoading('useLocationBtn', true);
  
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const location = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      };
      
      // Reverse geocode to get address
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ location }, (results, status) => {
        showLoading('useLocationBtn', false);
        
        if (status === 'OK' && results[0]) {
          document.getElementById('destinationInput').value = results[0].formatted_address;
          map.setCenter(location);
          map.setZoom(16);
        } else {
          document.getElementById('destinationInput').value = `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
        }
      });
    },
    (error) => {
      showLoading('useLocationBtn', false);
      showWarning('Could not get your location: ' + error.message);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function refreshParkingSpots() {
  // Simulate refreshing parking availability
  const refreshBtn = document.getElementById('refreshBtn');
  refreshBtn.style.transform = 'rotate(360deg)';
  
  setTimeout(() => {
    refreshBtn.style.transform = 'rotate(0deg)';
    showWarning('Parking availability updated!', 'info');
  }, 1000);
}

function resetAll() {
  // Clear map markers
  if (destinationMarker) {
    destinationMarker.setMap(null);
    destinationMarker = null;
  }
  if (nearestMarker) {
    nearestMarker.setMap(null);
    nearestMarker = null;
  }
  
  // Clear directions
  directionsRenderer.set('directions', null);
  currentRoute = null;
  
  // Reset form
  document.getElementById('destinationInput').value = '';
  document.getElementById('resultsPanel').classList.remove('show');
  document.getElementById('directionsBtn').disabled = true;
  
  // Hide warnings
  document.getElementById('warning').style.display = 'none';
  
  // Reset map view
  const bounds = new google.maps.LatLngBounds();
  parkingMarkers.forEach(marker => bounds.extend(marker.getPosition()));
  map.fitBounds(bounds);
  
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