/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@moonshift/shared"],
  reactStrictMode: true,
  devIndicators: false,
  async redirects() {
    return [{ source: "/marketplace", destination: "/market", permanent: true }];
  },
  async rewrites() {
    const target = (process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || "http://localhost:4000").replace(/\/+$/, "");
    return [
      { source: "/api/events", destination: `${target}/events` },
      { source: "/api/:path*", destination: `${target}/:path*` },
    ];
  },
};

export default nextConfig;
