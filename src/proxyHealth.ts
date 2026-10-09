import * as http from "http";

/** TCP 可连接不代表是本扩展、同一份统计存储的代理。 */
export function probeProxy(port: number, jsonlPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ host: "127.0.0.1", port, path: "/__deepseek_status_health" }, res => {
      let body = "";
      res.on("data", chunk => {
        body += chunk;
        if (body.length > 8192) { req.destroy(); resolve(false); }
      });
      res.on("error", () => resolve(false));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(res.statusCode === 200 && data.service === "deepseek-status-bar" && data.jsonlPath === jsonlPath);
        } catch { resolve(false); }
      });
    });
    const timeout = setTimeout(() => { req.destroy(); resolve(false); }, 1000);
    req.on("close", () => clearTimeout(timeout));
    req.on("error", () => resolve(false));
  });
}
