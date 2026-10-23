/** @type {import('next').NextConfig} */
const apiOrigin = process.env.API_INTERNAL_URL || "http://localhost:8080";

const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // SSE（/api/v1/events）がgzipでバッファされないよう、圧縮は前段の Caddy に任せる
  compress: false,
  // 本番は Caddy が /api を Go API へ直接振り分ける。開発時のみ Next 経由で転送する。
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
