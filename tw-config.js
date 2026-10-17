// Tailwind CDN theme shared by the pages that load desk.css (same as the inline config in pr.html)
const c = (v) => `rgb(var(--${v}) / <alpha-value>)`;
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: c('bg'), shell: c('shell'), surface: c('surface'), surface2: c('surface-2'),
        ink: c('ink'), ink2: c('ink-2'), line: c('line'),
        royal: c('royal'), brand: c('red'), purple: c('purple'), sky: c('sky'), gold: c('gold'),
        'royal-soft': c('royal-soft'), 'red-soft': c('red-soft'), 'purple-soft': c('purple-soft'),
        'sky-soft': c('sky-soft'), 'gold-soft': c('gold-soft'),
      },
      fontFamily: {
        display: ['Kanit', '"Noto Sans Thai"', 'sans-serif'],
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
