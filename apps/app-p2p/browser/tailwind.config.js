/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{html,ts}"],
  theme: {
    extend: {
      colors: {
        ["primary-900"]: "#c0e700",
        ["primary-500"]: "#9dc106",
        ["primary-100"]: "#1f230c",
        ["slate-900"]: "#191919",
        ["slate-800"]: "#2a2a2a",
        secondary: "#FFFFFF",
      },
      fontFamily: {
        sans: ['"Saira"'],
      },
    },
  },
  plugins: [],
};
