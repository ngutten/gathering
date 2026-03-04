// sodium-loader.js — Load libsodium UMD modules (classic script, not a module)
(function() {
  var modules = {};
  window.exports = {};
  window.require = function(name) { return modules[name]; };

  var s1 = document.createElement('script');
  s1.src = 'libsodium.js';
  s1.onload = function() {
    modules['libsodium-sumo'] = window.exports;
    window.exports = {};

    var s2 = document.createElement('script');
    s2.src = 'libsodium-wrappers.js';
    s2.onload = function() {
      window.sodium = window.exports;
      delete window.exports;
      delete window.require;
    };
    document.head.appendChild(s2);
  };
  document.head.appendChild(s1);
})();
