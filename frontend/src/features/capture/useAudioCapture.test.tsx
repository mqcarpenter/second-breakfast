import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioCaptureAvailability, useAudioCapture } from "./useAudioCapture";

class FakeRecorder extends EventTarget {
  static supported = true;
  static instances: FakeRecorder[] = [];
  static isTypeSupported = () => FakeRecorder.supported;
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  constructor(
    public stream: MediaStream,
    options: MediaRecorderOptions = {},
  ) {
    super();
    this.mimeType = options.mimeType ?? "audio/webm";
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    const data = new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType });
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data }));
    this.dispatchEvent(new Event("stop"));
  }
}

const track = { stop: vi.fn() };
const getUserMedia = vi.fn();

beforeEach(() => {
  FakeRecorder.instances = [];
  FakeRecorder.supported = true;
  track.stop.mockClear();
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [track] });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("audioCaptureAvailability", () => {
  it("is available with a recorder and a supported container", () => {
    expect(audioCaptureAvailability()).toEqual({ available: true });
  });
  it("explains itself when no container is supported", () => {
    FakeRecorder.supported = false;
    expect(audioCaptureAvailability().available).toBe(false);
  });
  it("explains itself on an insecure page", () => {
    vi.stubGlobal("isSecureContext", false);
    const result = audioCaptureAvailability();
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toMatch(/HTTPS/);
  });
});

describe("useAudioCapture", () => {
  it("records, then hands back a named file and frees the microphone", async () => {
    const onRecorded = vi.fn();
    const { result } = renderHook(() => useAudioCapture({ onRecorded }));
    await act(async () => result.current.start());
    expect(result.current.recording).toBe(true);
    act(() => result.current.stop());
    expect(result.current.recording).toBe(false);
    expect(track.stop).toHaveBeenCalled();
    expect(onRecorded).toHaveBeenCalledTimes(1);
    const file = onRecorded.mock.calls[0]?.[0] as File;
    expect(file.name).toMatch(/^voice-note-.*\.webm$/);
    expect(file.type).toBe("audio/webm");
    expect(file.size).toBe(3);
  });

  it("reports a blocked microphone in plain words", async () => {
    getUserMedia.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    const { result } = renderHook(() =>
      useAudioCapture({ onRecorded: vi.fn() }),
    );
    await act(async () => result.current.start());
    expect(result.current.recording).toBe(false);
    expect(result.current.error).toMatch(/blocked/i);
  });

  it("drops the clip and releases the microphone if the sheet closes mid-recording", async () => {
    const onRecorded = vi.fn();
    const { result, unmount } = renderHook(() =>
      useAudioCapture({ onRecorded }),
    );
    await act(async () => result.current.start());
    unmount();
    expect(track.stop).toHaveBeenCalled();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("an empty recording produces no file", async () => {
    const onRecorded = vi.fn();
    const { result } = renderHook(() => useAudioCapture({ onRecorded }));
    await act(async () => result.current.start());
    const recorder = FakeRecorder.instances[0] as FakeRecorder;
    recorder.stop = () => {
      recorder.state = "inactive";
      recorder.dispatchEvent(new Event("stop"));
    };
    act(() => result.current.stop());
    expect(onRecorded).not.toHaveBeenCalled();
  });
});
