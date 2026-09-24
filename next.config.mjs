/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.EDGEONE_BUILD === "1" || process.env.VERCEL_BUILD === "1" ? {} : { output: "standalone" }),
  poweredByHeader: false,
  reactStrictMode: true,
};
export default nextConfig;
