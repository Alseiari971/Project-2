// Sets the page's language and direction before anything is drawn, so an
// Arabic page doesn't flash left to right first. i18n.js makes the same choice.
(function () {
  var choice = null;
  try {
    choice = localStorage.getItem('gs-lang');
  } catch (e) {}
  var arabic = choice !== 'en'; // Arabic until the visitor picks English
  document.documentElement.lang = arabic ? 'ar' : 'en';
  document.documentElement.dir = arabic ? 'rtl' : 'ltr';
})();
