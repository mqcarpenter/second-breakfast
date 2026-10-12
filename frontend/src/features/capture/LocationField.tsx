import { Check, MapPin, Search } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client/api";
import type { LocationResult } from "../../api/generated/types.gen";
import { useOnlineStatus } from "../../app/offline/useOnlineStatus";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { type CapturePlace, readRecentPlaces } from "./recentPlaces";

/**
 * Where an entry was written. Four ways to say it, so a place is never blocked
 * on one service:
 *
 * - **Use my location** -- device GPS. Offline it saves coordinates; the place
 *   is named when the entry syncs.
 * - **Type a place** -- saves just the name. Works fully offline.
 * - **Search** -- looks the name up (OpenStreetMap, through your server) and
 *   returns coordinates. Needs the server, and only runs when pressed, because
 *   the query text leaves your network.
 * - **Recent places** -- earlier captures, remembered on this device. Offline too.
 */

export type CaptureLocation = CapturePlace;

function readGps(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      reject,
      { timeout: 10_000, maximumAge: 60_000 },
    );
  });
}

function fromResult(result: LocationResult): CaptureLocation {
  return {
    place: {
      name: result.name,
      locality: result.locality,
      admin_area: result.admin_area,
      country: result.country,
      timezone: result.timezone,
    },
    latitude: result.latitude,
    longitude: result.longitude,
  };
}

export function describeLocation(value: CaptureLocation): string {
  if (value.place.name) return value.place.name;
  if (value.latitude != null && value.longitude != null)
    return `${value.latitude.toFixed(4)}, ${value.longitude.toFixed(4)}`;
  return "Location";
}

export function LocationField({
  value,
  onChange,
  disabled,
}: {
  value: CaptureLocation | null;
  onChange: (value: CaptureLocation | null) => void;
  disabled?: boolean;
}) {
  const online = useOnlineStatus();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [message, setMessage] = useState("");
  const [recents] = useState(readRecentPlaces);

  if (value) {
    return (
      <div className="jv-capture__location">
        <span className="jv-capture__place">
          <MapPin aria-hidden="true" size={14} />
          <span className="jv-label jv-truncate">
            {describeLocation(value)}
          </span>
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange(null)}
          disabled={disabled}
        >
          Remove location
        </Button>
      </div>
    );
  }

  const typed = query.trim();

  const applyGps = async () => {
    setMessage("");
    setLocating(true);
    try {
      const { latitude, longitude } = await readGps();
      // Unnamed for now; the server names it when the entry syncs.
      onChange({ place: { name: "" }, latitude, longitude });
    } catch {
      setMessage(
        "Couldn't get your location. Check that location access is on.",
      );
    } finally {
      setLocating(false);
    }
  };

  const applyTypedName = () => {
    if (!typed) return;
    onChange({ place: { name: typed }, latitude: null, longitude: null });
  };

  const search = async () => {
    if (!typed) return;
    setMessage("");
    setSearching(true);
    try {
      const response = await api.searchLocation(typed);
      const found = response.results ?? [];
      setResults(found);
      if (found.length === 0)
        setMessage("No places found. You can still use the name as typed.");
    } catch {
      setResults(null);
      setMessage(
        "Couldn't search right now. You can still use the name as typed.",
      );
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="jv-capture__place-picker">
      <div className="jv-capture__actions">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void applyGps()}
          disabled={disabled || locating}
        >
          <MapPin aria-hidden="true" size={15} />
          {locating ? "Finding location…" : "Use my location"}
        </Button>
      </div>

      <div className="jv-capture__field">
        <label className="jv-label" htmlFor="capture-place">
          Or name a place
        </label>
        <Input
          id="capture-place"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setResults(null);
            setMessage("");
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (online) void search();
            else applyTypedName();
          }}
          placeholder="Café, trailhead, a friend's place…"
          autoComplete="off"
          disabled={disabled}
        />
        <div className="jv-capture__actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={applyTypedName}
            disabled={disabled || !typed}
          >
            <Check aria-hidden="true" size={15} />
            Use this name
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void search()}
            disabled={disabled || !typed || searching || !online}
            title={
              online ? undefined : "Searching needs a connection to your server"
            }
          >
            <Search aria-hidden="true" size={15} />
            {searching ? "Searching…" : "Search"}
          </Button>
        </div>
        {!online && (
          <p className="jv-caption">
            Search needs a connection. The name is saved as typed.
          </p>
        )}
        {message && (
          <p className="jv-caption" role="status">
            {message}
          </p>
        )}
      </div>

      {results && results.length > 0 && (
        <ul className="jv-capture__results" aria-label="Matching places">
          {results.map((result) => (
            <li key={`${result.name}-${result.latitude}-${result.longitude}`}>
              <button
                type="button"
                className="jv-capture__result"
                onClick={() => onChange(fromResult(result))}
              >
                <MapPin aria-hidden="true" size={14} />
                <span className="jv-truncate">{result.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {recents.length > 0 && (
        <div className="jv-capture__field">
          <span className="jv-label">Recent places</span>
          <ul className="jv-capture__chips" aria-label="Recent places">
            {recents.map((recent) => (
              <li
                key={`${recent.place.name}-${recent.latitude}-${recent.longitude}`}
              >
                <button
                  type="button"
                  className="jv-capture__chip"
                  onClick={() => onChange(recent)}
                  disabled={disabled}
                >
                  {recent.place.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
