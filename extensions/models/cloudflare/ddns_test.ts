import { isAddress, ManagedRecordSchema, planRecordAction } from "./ddns.ts";

Deno.test("address discovery validates IPv4 and IPv6 values", () => {
  if (!isAddress("A", "203.0.113.10")) throw new Error("valid IPv4 rejected");
  if (!isAddress("AAAA", "::")) {
    throw new Error("valid compressed IPv6 rejected");
  }
  if (isAddress("AAAA", ":")) throw new Error("malformed IPv6 accepted");
  if (isAddress("AAAA", "1::2::3")) {
    throw new Error("multiple compression accepted");
  }
  if (isAddress("A", "01.2.3.4")) {
    throw new Error("IPv4 with leading zero accepted");
  }
  if (!isAddress("AAAA", "2001:db8::10")) {
    throw new Error("valid IPv6 rejected");
  }
  if (isAddress("AAAA", "not-an-ip")) throw new Error("invalid IPv6 accepted");
});

Deno.test("managed DNS names reject Unicode input", () => {
  const unicodeName = ManagedRecordSchema.safeParse({
    name: "éxample.test",
    type: "A",
  });
  if (unicodeName.success) throw new Error("Unicode DNS name was accepted");
});

Deno.test("DDNS planning changes only drifted managed records", () => {
  const desired = {
    name: "nc.example.test",
    type: "A" as const,
    ttl: 300,
    proxied: false,
  };
  const current = {
    id: "record-1",
    name: desired.name,
    type: desired.type,
    content: "203.0.113.10",
    ttl: 300,
    proxied: false,
    comment: null,
  };
  if (planRecordAction(desired, "203.0.113.10", current) !== "unchanged") {
    throw new Error("matching record was not idempotent");
  }
  if (planRecordAction(desired, "203.0.113.11", current) !== "updated") {
    throw new Error("address drift was not updated");
  }
  if (planRecordAction(desired, "203.0.113.10", undefined) !== "created") {
    throw new Error("missing record was not created");
  }

  const ipv6Desired = {
    name: "v6.example.test",
    type: "AAAA" as const,
    ttl: 300,
    proxied: false,
  };
  const ipv6Current = {
    id: "record-v6",
    name: ipv6Desired.name,
    type: ipv6Desired.type,
    content: "2001:db8:0:0:0:0:0:1",
    ttl: 300,
    proxied: false,
    comment: null,
  };
  if (
    planRecordAction(ipv6Desired, "2001:db8::1", ipv6Current) !== "unchanged"
  ) {
    throw new Error("equivalent IPv6 spelling was treated as drift");
  }
});
