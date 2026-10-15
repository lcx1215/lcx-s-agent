import { describe, expect, it } from "vitest";
import { buildGatewayTlsSubjectAltNames } from "./gateway.js";

describe("buildGatewayTlsSubjectAltNames", () => {
  it("covers browser loopback URLs, the machine hostname, and assigned network addresses", () => {
    const names = buildGatewayTlsSubjectAltNames({
      hostname: "LCX-Mac.local.",
      interfaces: [
        { address: "127.0.0.1", internal: true },
        { address: "192.168.1.20", internal: false },
        { address: "100.64.0.10", internal: false },
        { address: "2001:db8::1%en0", internal: false },
        { address: "0.0.0.0", internal: false },
        { address: "::", internal: false },
        { address: "not-an-ip", internal: false },
      ],
    });

    expect(names).toEqual([
      "DNS:localhost",
      "IP:127.0.0.1",
      "IP:::1",
      "DNS:lcx-mac.local",
      "IP:192.168.1.20",
      "IP:100.64.0.10",
      "IP:2001:db8::1",
    ]);
  });

  it("omits unsafe hostnames and unspecified addresses", () => {
    const names = buildGatewayTlsSubjectAltNames({
      hostname: "*.example.com,IP:127.0.0.1",
      interfaces: [
        { address: "0.0.0.0", internal: false },
        { address: "::", internal: false },
      ],
    });

    expect(names).toEqual(["DNS:localhost", "IP:127.0.0.1", "IP:::1"]);
  });
});
