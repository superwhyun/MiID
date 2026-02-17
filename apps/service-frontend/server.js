const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.FRONTEND_PORT || 3000);
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:15000";

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
}

function proxyRequest(req, res, targetPath) {
  const url = `${BACKEND_URL}${targetPath}`;

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", () => {
    const fetchOptions = {
      method: req.method,
      headers: { "Content-Type": "application/json" }
    };

    if (body && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")) {
      fetchOptions.body = body;
    }

    if (req.headers.cookie) {
      fetchOptions.headers.cookie = req.headers.cookie;
    }

    fetch(url, fetchOptions)
      .then(async (backendRes) => {
        const data = await backendRes.text();
        const setCookieHeader = backendRes.headers.get("set-cookie");
        const responseHeaders = {
          "Content-Type": backendRes.headers.get("content-type") || "application/json"
        };
        if (setCookieHeader) {
          responseHeaders["Set-Cookie"] = setCookieHeader;
        }
        res.writeHead(backendRes.status, responseHeaders);
        res.end(data);
      })
      .catch((err) => {
        console.error("Proxy error:", err.message);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "backend_unavailable", message: err.message }));
      });
  });
}

function proxySSE(req, res, targetPath) {
  const target = new URL(`${BACKEND_URL}${targetPath}`);
  const client = target.protocol === "https:" ? https : http;

  const upstreamReq = client.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        cookie: req.headers.cookie || ""
      }
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });

      upstreamRes.on("data", (chunk) => {
        res.write(chunk);
      });
      upstreamRes.on("end", () => {
        res.end();
      });
    }
  );

  upstreamReq.on("error", (err) => {
    console.error("SSE proxy error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "backend_unavailable", message: err.message }));
    } else {
      res.end();
    }
  });

  req.on("close", () => {
    upstreamReq.destroy();
  });

  upstreamReq.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    const backendPath = pathname.replace("/api", "");
    if (backendPath.startsWith("/auth/stream/") || backendPath === "/session/stream") {
      proxySSE(req, res, backendPath + url.search);
      return;
    }
    proxyRequest(req, res, backendPath + url.search);
    return;
  }

  const publicDir = path.join(__dirname, "public");

  if (pathname === "/" || pathname === "/index.html") {
    serveStatic(res, path.join(publicDir, "index.html"));
  } else {
    const filePath = path.join(publicDir, pathname);
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    serveStatic(res, filePath);
  }
});

server.listen(PORT, () => {
  console.log(`service-frontend listening on http://localhost:${PORT}`);
  console.log(`proxying API requests to ${BACKEND_URL}`);
});

module.exports = { server };
