/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        lenticchia: {
          primary:     '#647144',
          dark:        '#525E36',
          light:       '#EEF2E4',
          accent:      '#D47A4A',
          bg:          '#F9F8F4',
          text:        '#2C3026',
          muted:       '#858A7A',
          border:      '#EBE6DC',
        }
      },
      fontFamily: {
        serif: ['Lora', 'Georgia', 'serif'],
        sans:  ['DM Sans', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        'card': '20px',
        'pill': '999px',
      },
      boxShadow: {
        'card':   '0 6px 28px rgba(44,48,38,0.09), 0 1px 4px rgba(44,48,38,0.06)',
        'navbar': '0 8px 32px rgba(44,48,38,0.35), 0 2px 8px rgba(44,48,38,0.15)',
        'btn':    '0 8px 20px rgba(100,113,68,0.25)',
      }
    },
  },
  plugins: [],
}
