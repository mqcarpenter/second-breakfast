import { useCallback, useEffect, useRef, useState } from "react";
import {
  baseMimeType,
  extensionForMime,
  pickRecorderMime,
  REQUESTED_BITS_PER_SECOND,
} from "../editor/dictationFormat";

/**
 * Records one audio clip into memory and hands it back as a `File`.
 *
 * Deliberately smaller than the editor's dictation recorder: capture has no
 * document to anchor into and no server to upload to yet, so there is no
 * staging and no chunked persistence -- the clip is gathered while the sheet is
 * open and goes into the outbox when the entry is saved. It reuses the editor's
 * container choice and file naming so the server sees the same formats.
 *
 * Limit (docs/features/pwa.md): a clip still being recorded is lost if the app
 * is killed before Stop. The outbox protects it from then on.
 */

export type AudioCaptureAvailability =
  | { available: true }
  | { available: false; reason: string };

export function audioCaptureAvailability(): AudioCaptureAvailability {
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return {
      available: false,
      reason: "Recording needs a secure (HTTPS) connection.",
    };
  }
  const ok =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined" &&
    pickRecorderMime((type) => MediaRecorder.isTypeSupported(type)) !== null;
  return ok
    ? { available: true }
    : { available: false, reason: "This browser can't record audio." };
}

function describeError(caught: unknown): string {
  const name = caught instanceof DOMException ? caught.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access was blocked. Allow it in Settings to record.";
  if (name === "NotFoundError") return "No microphone was found.";
  return "Couldn't start recording. Try again.";
}

export function useAudioCapture({
  onRecorded,
}: {
  onRecorded: (file: File) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const discardRef = useRef(false);
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;

  const release = useCallback(() => {
    window.clearInterval(timerRef.current);
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
  }, []);

  // Leaving the sheet mid-recording releases the microphone and drops the clip.
  useEffect(
    () => () => {
      discardRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      release();
    },
    [release],
  );

  const start = useCallback(async () => {
    setError("");
    const availability = audioCaptureAvailability();
    if (!availability.available) {
      setError(availability.reason);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickRecorderMime((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: REQUESTED_BITS_PER_SECOND,
      });
      chunksRef.current = [];
      discardRef.current = false;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        const type = recorder.mimeType || mime || "audio/webm";
        const chunks = chunksRef.current;
        chunksRef.current = [];
        const keep = !discardRef.current && chunks.length > 0;
        release();
        if (!keep) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        onRecordedRef.current(
          new File(chunks, `voice-note-${stamp}.${extensionForMime(type)}`, {
            type: baseMimeType(type),
          }),
        );
      });
      recorder.start();
      recorderRef.current = recorder;
      streamRef.current = stream;
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setRecording(true);
      timerRef.current = window.setInterval(
        () => setElapsedMs(Date.now() - startedAtRef.current),
        250,
      );
    } catch (caught) {
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      setError(describeError(caught));
      release();
    }
  }, [release]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  return { recording, elapsedMs, error, start, stop };
}
