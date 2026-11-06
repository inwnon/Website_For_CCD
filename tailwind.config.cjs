// Tailwind build for every page (npm run build:css → assets/app.css). Same theme the pages used with the Tailwind CDN.
// Colours are CSS variables defined in each page (light and dark), so the classes follow the theme.
const c = (v) => `rgb(var(--${v}) / <alpha-value>)`;
module.exports = {
  content: ['./*.html', './*.js', './server/**/*.mjs'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: c('bg'), shell: c('shell'), surface: c('surface'), surface2: c('surface-2'),
        ink: c('ink'), ink2: c('ink-2'), line: c('line'), 'line-strong': c('line-strong'),
        royal: c('royal'), brand: c('red'), purple: c('purple'), sky: c('sky'), gold: c('gold'),
        'royal-soft': c('royal-soft'), 'red-soft': c('red-soft'), 'purple-soft': c('purple-soft'),
        'sky-soft': c('sky-soft'), 'gold-soft': c('gold-soft'),
      },
      fontFamily: {
        display: ['Prompt', '"Noto Sans Thai"', 'sans-serif'],
        sans: ['"Noto Sans Thai"', 'system-ui', 'sans-serif'],
      },
      spacing: {
        shell: 'clamp(16px, 3.2vw, 46px)',
        shelf: 'clamp(40px, 5vw, 56px)',
      },
      maxWidth: { page: '1410px' },
      borderRadius: { card: '20px', banner: '28px', shell: '32px' },
      boxShadow: {
        raised: 'var(--shadow-raised)',
        float: 'var(--shadow-float)',
        glow: 'var(--shadow-glow)',
      },
    },
  },
};
