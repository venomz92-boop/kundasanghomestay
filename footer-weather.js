/* /footer-weather.js — Live Kundasang weather widget
 * Uses Open-Meteo (free, no API key, CORS-friendly)
 * Caches result in localStorage for 30 minutes
 */
(function () {
  'use strict';

  var WIDGET_ID = 'kdWeatherWidget';
  var LAT = 5.9833;
  var LON = 116.5667;
  var CACHE_KEY = 'kd_weather_cache_v1';
  var CACHE_TTL_MS = 30 * 60 * 1000;

  // WMO weather codes
  var WMO = {
    0:  { icon: '☀️', label: 'Clear sky' },
    1:  { icon: '🌤️', label: 'Mainly clear' },
    2:  { icon: '⛅', label: 'Partly cloudy' },
    3:  { icon: '☁️', label: 'Overcast' },
    45: { icon: '🌫️', label: 'Fog' },
    48: { icon: '🌫️', label: 'Rime fog' },
    51: { icon: '🌦️', label: 'Light drizzle' },
    53: { icon: '🌦️', label: 'Drizzle' },
    55: { icon: '🌧️', label: 'Heavy drizzle' },
    56: { icon: '🌧️', label: 'Freezing drizzle' },
    57: { icon: '🌧️', label: 'Freezing drizzle' },
    61: { icon: '🌧️', label: 'Light rain' },
    63: { icon: '🌧️', label: 'Rain' },
    65: { icon: '🌧️', label: 'Heavy rain' },
    66: { icon: '🌧️', label: 'Freezing rain' },
    67: { icon: '🌧️', label: 'Freezing rain' },
    71: { icon: '🌨️', label: 'Light snow' },
    73: { icon: '🌨️', label: 'Snow' },
    75: { icon: '❄️', label: 'Heavy snow' },
    77: { icon: '🌨️', label: 'Snow grains' },
    80: { icon: '🌦️', label: 'Rain showers' },
    81: { icon: '🌧️', label: 'Rain showers' },
    82: { icon: '⛈️', label: 'Heavy showers' },
    85: { icon: '🌨️', label: 'Snow showers' },
    86: { icon: '❄️', label: 'Snow showers' },
    95: { icon: '⛈️', label: 'Thunderstorm' },
    96: { icon: '⛈️', label: 'Storm + hail' },
    99: { icon: '⛈️', label: 'Storm + hail' }
  };

  function info(code) {
    return WMO[code] || { icon: '🌡️', label: 'Mountain air' };
  }

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.ts || !parsed.data) return null;
      if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
      return parsed.data;
    } catch (e) { return null; }
  }

  function writeCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) { /* ignore */ }
  }

  function render(data) {
    var el = document.getElementById(WIDGET_ID);
    if (!el || !data) return;

    var temp = Math.round(data.temperature_2m);
    var hum = Math.round(data.relative_humidity_2m);
    var w = info(data.weather_code);
    var now = new Date();
    var time = now.toLocaleTimeString('en-MY', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    el.innerHTML =
      '<div class="kd-weather-row">' +
        '<div class="kd-weather-icon" aria-hidden="true">' + w.icon + '</div>' +
        '<div class="kd-weather-main">' +
          '<div class="kd-weather-temp">' + temp + '°C</div>' +
          '<div class="kd-weather-desc">' + w.label + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="kd-weather-meta">💧 ' + hum + '% humidity</div>' +
      '<div class="kd-weather-updated">Updated ' + time + '</div>';
  }

  function renderFallback() {
    var el = document.getElementById(WIDGET_ID);
    if (!el) return;
    el.innerHTML =
      '<div class="kd-weather-row">' +
        '<div class="kd-weather-icon" aria-hidden="true">🏔️</div>' +
        '<div class="kd-weather-main">' +
          '<div class="kd-weather-temp">18–23°C</div>' +
          '<div class="kd-weather-desc">Cool mountain air</div>' +
        '</div>' +
      '</div>' +
      '<div class="kd-weather-meta">Bring a warm jacket!</div>';
  }

  function fetchWeather() {
    var url =
      'https://api.open-meteo.com/v1/forecast' +
      '?latitude=' + LAT +
      '&longitude=' + LON +
      '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&timezone=Asia%2FKuala_Lumpur';

    fetch(url, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        if (json && json.current) {
          writeCache(json.current);
          render(json.current);
        } else {
          renderFallback();
        }
      })
      .catch(function () {
        renderFallback();
      });
  }

  function init() {
    if (!document.getElementById(WIDGET_ID)) return;
    var cached = readCache();
    if (cached) {
      render(cached);
      fetchWeather();
    } else {
      fetchWeather();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
