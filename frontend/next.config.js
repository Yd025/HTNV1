/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  transpilePackages: ["three", "@react-three/fiber", "@react-three/drei"],
};

module.exports = nextConfig;
