import type { SVGProps } from "react";

const Rubymine = (props: SVGProps<SVGSVGElement>) => (
  <svg {...props} viewBox="0 0 105 105">
    <linearGradient
      id="a"
      x1="65.05"
      x2="52.91"
      y1="60.03"
      y2="28.18"
      gradientUnits="userSpaceOnUse"
    >
      <stop offset="0" stopColor="#fe2857" />
      <stop offset=".06" stopColor="#fe3052" />
      <stop offset=".33" stopColor="#fd533b" />
      <stop offset=".58" stopColor="#fc6c2a" />
      <stop offset=".81" stopColor="#fc7b20" />
      <stop offset="1" stopColor="#fc801d" />
    </linearGradient>
    <linearGradient
      id="b"
      x1="41.93"
      x2="60.67"
      y1="14.45"
      y2="31.63"
      gradientUnits="userSpaceOnUse"
    >
      <stop offset="0" stopColor="#6b57ff" />
      <stop offset="1" stopColor="#fe2857" />
    </linearGradient>
    <linearGradient
      id="c"
      x1="3.92"
      x2="65.63"
      y1="19.88"
      y2="98.32"
      gradientUnits="userSpaceOnUse"
    >
      <stop offset="0" stopColor="#6b57ff" />
      <stop offset=".3" stopColor="#fe2857" />
      <stop offset=".63" stopColor="#fe2857" />
      <stop offset=".64" stopColor="#fe3052" />
      <stop offset=".7" stopColor="#fd533b" />
      <stop offset=".76" stopColor="#fc6c2a" />
      <stop offset=".81" stopColor="#fc7b20" />
      <stop offset=".85" stopColor="#fc801d" />
    </linearGradient>
    <path
      fill="url(#a)"
      d="m83.34 4.5-27.47 9.84L34.22 4.5l-7.13 17.96h-4.61v53.02l66.67.58 10.35-52.8z"
    />
    <path fill="url(#b)" d="m82.52 38.95-43.87-26 43.87 51.42z" />
    <path
      fill="url(#c)"
      d="m43.46 98 35.88-4.78-5.57-10.71h8.75V64.37l-43.88-51.5L3.5 21.5l.04 50.4 20.2 28.6 19.61-2.49.09-.01z"
    />
  </svg>
);

export { Rubymine };
