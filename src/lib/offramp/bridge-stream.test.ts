import test from "node:test";
import assert from "node:assert/strict";
import { driveBridgeTransfer } from "./bridge-stream";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  url: string;
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  close() {
    this.closed = true;
  }
}

function withFakes(run: () => void) {
  const g = globalThis as Record<string, unknown>;
  g.window = {};
  g.EventSource = FakeEventSource;
  try {
    run();
  } finally {
    delete g.window;
    delete g.EventSource;
  }
}

test("driveBridgeTransfer closes the stream once the transfer finishes", () => {
  withFakes(() => {
    const stop = driveBridgeTransfer("abc");
    const es = FakeEventSource.last!;
    assert.equal(es.url, "/api/offramp/bridge/stream/abc");
    es.onmessage!({ data: JSON.stringify({ status: "attesting" }) });
    assert.equal(es.closed, false);
    es.onmessage!({ data: JSON.stringify({ status: "completed" }) });
    assert.equal(es.closed, true);
    stop();
  });
});

test("driveBridgeTransfer closes on failure too, and ignores junk frames", () => {
  withFakes(() => {
    const stop = driveBridgeTransfer("def");
    const es = FakeEventSource.last!;
    es.onmessage!({ data: "not json" });
    assert.equal(es.closed, false);
    es.onmessage!({ data: JSON.stringify({ status: "failed" }) });
    assert.equal(es.closed, true);
    stop();
  });
});
