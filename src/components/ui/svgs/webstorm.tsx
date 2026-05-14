import type { SVGProps } from "react";

const Webstorm = (props: SVGProps<SVGSVGElement>) => (
  <svg
    {...props}
    xmlnsXlink="http://www.w3.org/1999/xlink"
    viewBox="0 0 105 105"
  >
    <linearGradient
      id="a"
      x1="38.88"
      x2="63.72"
      y1="6.5"
      y2="95.94"
      gradientUnits="userSpaceOnUse"
    >
      <stop offset=".28" stopColor="#07c3f2" />
      <stop offset=".94" stopColor="#087cfa" />
    </linearGradient>
    <linearGradient
      id="b"
      x1="46.63"
      x2="88.66"
      y1="17.85"
      y2="79.48"
      gradientUnits="userSpaceOnUse"
    >
      <stop offset=".14" stopColor="#fcf84a" />
      <stop offset=".37" stopColor="#07c3f2" />
    </linearGradient>
    <linearGradient
      xlinkHref="#a"
      id="c"
      x1="88.27"
      x2="93.79"
      y1="25.47"
      y2="45.02"
    />
    <path
      fill="url(#a)"
      d="M17.44 91.26 4.5 14.56l23.93-9.93 15.28 9.08 14-7.55 29.17 11.2-16.36 83.14z"
    />
    <path
      fill="url(#b)"
      d="M100.5 37.01 88.11 6.41 65.63 4.5l-34.7 33.34 9.34 42.97 17.44 12.23 42.79-25.39L90 47.96z"
    />
    <path fill="url(#c)" d="M81.27 32.45 90 47.96l10.5-10.95-7.71-19.06z" />
  </svg>
);

export { Webstorm };
