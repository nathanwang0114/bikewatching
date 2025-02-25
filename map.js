import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';

console.log("Mapbox GL JS Loaded:", mapboxgl);

// Set your Mapbox access token
mapboxgl.accessToken = 'pk.eyJ1IjoibmF0aGFud2FuZzAxMTQiLCJhIjoiY203anV0Z3llMDZxZjJsb29xbTBqZnZhNiJ9.WJhU26rmp9KoggB9pTroaw';

// Initialize the map
const map = new mapboxgl.Map({
  container: 'map', 
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027], 
  zoom: 12, 
  minZoom: 5,
  maxZoom: 18 
});

const bikeLaneStyle = {
  'line-color': '#32D400',
  'line-width': 5,
  'line-opacity': 0.6
};

const svg = d3.select('#map').select('svg');

// Helper function to project station coordinates to screen coords
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

// Define station & trip variables
let stations = [];
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// Radius scale setup
const radiusScale = d3.scaleSqrt().range([2, 20]);

let stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

map.on('load', async () => {
  // 1) Load Bike Lane Data
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson'
  });
  map.addLayer({
    id: 'boston-bike-lanes',
    type: 'line',
    source: 'boston_route',
    paint: bikeLaneStyle
  });

  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson'
  });
  map.addLayer({
    id: 'cambridge-bike-lanes',
    type: 'line',
    source: 'cambridge_route',
    paint: bikeLaneStyle
  });

  // 2) Load station data
  try {
    const stationJsonUrl = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
    const stationJsonData = await d3.json(stationJsonUrl);
    stations = stationJsonData.data.stations;

    // 3) Load trip data & precompute departure/arrival buckets
    const tripCsvUrl = 'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';
    const trips = await d3.csv(tripCsvUrl, (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);

      let startedMinutes = minutesSinceMidnight(trip.started_at);
      let endedMinutes = minutesSinceMidnight(trip.ended_at);

      departuresByMinute[startedMinutes].push(trip);
      arrivalsByMinute[endedMinutes].push(trip);
      
      return trip;
    });

    // 4) Compute initial station traffic
    stations = computeStationTraffic(stations);
    radiusScale.domain([0, d3.max(stations, d => d.totalTraffic) || 0]);

    // 5) Draw circles for each station
    const circles = svg.selectAll('circle')
      .data(stations, d => d.short_name)
      .enter()
      .append('circle')
      .attr('r', d => radiusScale(d.totalTraffic))
      .attr('fill', 'steelblue')
      .attr('stroke', 'white')
      .attr('stroke-width', 1)
      .attr('opacity', 0.6)
      .attr('pointer-events', 'auto')
      .style("--departure-ratio", d => stationFlow(d.departures / d.totalTraffic)) 
      .each(function(d) {
        d3.select(this)
          .append('title')
          .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
      });

    // Update positions dynamically
    function updatePositions() {
      circles.attr('cx', d => getCoords(d).cx).attr('cy', d => getCoords(d).cy);
    }
    updatePositions();
    map.on('move', updatePositions);
    map.on('zoom', updatePositions);
    map.on('resize', updatePositions);
    map.on('moveend', updatePositions);

    // 6) Handle the slider filtering
    const timeSlider = document.getElementById('time-slider');
    const selectedTime = document.getElementById('time-display');
    const anyTimeLabel = document.getElementById('any-time');

    function formatTime(minutes) {
      const date = new Date(0, 0, 0, 0, minutes);
      return date.toLocaleString('en-US', { timeStyle: 'short' });
    }

    function updateTimeDisplay() {
      const timeFilterValue = +timeSlider.value;
      if (timeFilterValue === -1) {
        selectedTime.textContent = '';
        anyTimeLabel.style.display = 'inline';
      } else {
        selectedTime.textContent = formatTime(timeFilterValue);
        anyTimeLabel.style.display = 'none';
      }
      updateScatterPlot(timeFilterValue);
    }

    timeSlider.addEventListener('input', updateTimeDisplay);
    updateTimeDisplay();

    function updateScatterPlot(timeFilter) {
      const filteredStations = computeStationTraffic(stations, timeFilter);
      const maxTraffic = d3.max(filteredStations, d => d.totalTraffic) || 0;
      radiusScale.domain([0, maxTraffic]).range(timeFilter === -1 ? [2, 20] : [4, 30]);

      circles
        .data(filteredStations, d => d.short_name)
        .join('circle')
        .transition()
        .duration(300)
        .attr('r', d => radiusScale(d.totalTraffic))
        .style('--departure-ratio', (d) => {
            let ratio = d.totalTraffic === 0 ? 0.5 : stationFlow(d.departures / d.totalTraffic);
            return ratio;
        });
    }

  } catch (error) {
    console.error('Error loading data:', error);
  }
});

/* --- Optimized Functions for Performance --- */

// Compute station traffic based on pre-filtered trip buckets
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    v => v.length,
    d => d.start_station_id
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    v => v.length,
    d => d.end_station_id
  );

  return stations.map((station) => ({
    ...station,
    arrivals: arrivals.get(station.short_name) ?? 0,
    departures: departures.get(station.short_name) ?? 0,
    totalTraffic: (arrivals.get(station.short_name) ?? 0) + (departures.get(station.short_name) ?? 0)
  }));
}

// Efficient filtering of trips using precomputed buckets
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) return tripsByMinute.flat();

  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;

  // Handle time filtering across midnight
  if (minMinute > maxMinute) {
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute).flat();
  }
}

// Convert Date object to minutes since midnight
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}
