import type { SVGProps } from "react";

const Rider = (props: SVGProps<SVGSVGElement>) => (
  <svg {...props} preserveAspectRatio="xMidYMid" viewBox="0 0 256 256">
    <defs>
      <linearGradient x1="90.8%" y1="81.8%" x2="-19.1%" y2="19%" id="a">
        <stop stopColor="#DD1265" offset="0%" />
        <stop stopColor="#DD1265" offset="48%" />
        <stop stopColor="#FDB60D" offset="94%" />
      </linearGradient>
      <linearGradient x1="36%" y1="7.3%" x2="53.7%" y2="93%" id="b">
        <stop stopColor="#087CFA" offset="14%" />
        <stop stopColor="#DD1265" offset="48%" />
        <stop stopColor="#087CFA" offset="96%" />
      </linearGradient>
      <linearGradient x1="39.5%" y1="11.4%" x2="56.9%" y2="91.7%" id="c">
        <stop stopColor="#DD1265" offset="28%" />
        <stop stopColor="#FDB60D" offset="97%" />
      </linearGradient>
    </defs>
    <path fill="url(#a)" d="M256 99.6 76.5 0l120.2 178.5 24.7-16.2z" />
    <path
      fill="url(#b)"
      d="M184.4 59 161.9 4l-49.7 49 20.3 177.6 48.2 25.4 75.3-44z"
    />
    <path fill="url(#c)" d="M76.5 0 0 51.5l28.5 175.9 73.3 28.2 94.9-77.1z" />
  </svg>
);

export { Rider };
