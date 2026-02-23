module.exports = {
  css: ['assets/css/bootstrap.rtl.min.css'],
  content: ['index.html', 'assets/js/script.js'],
  output: 'assets/css/bootstrap.rtl.min.purged.css',
  safelist: {
    standard: [
      'show',
      'collapsing',
      'offcanvas',
      'offcanvas-start',
      'offcanvas-end',
      'modal',
      'modal-backdrop',
      'dropdown-menu',
      'fade',
    ],
    greedy: [/^(show|collaps|offcanvas|modal|dropdown|active|disabled|rtl)/],
  },
};
