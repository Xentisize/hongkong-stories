import { describe, expect, test } from "bun:test";

import {
  AudioDirector,
  MUSIC_GAIN_DB,
  SFX_GAIN_DB,
  gainFor,
  musicFor,
  type AudioSink,
} from "./audio";

/**
 * Music policy.
 *
 * What is asserted here is the set of decisions — which bed a location asks for, when a bed is
 * restarted, what a silent location does — because those are the parts that differ audibly. The
 * `AudioContext` itself is the injected sink's problem.
 */

function recordingSink(): AudioSink & { played: string[]; stops: number } {
  const played: string[] = [];
  return {
    played,
    stops: 0,
    play(track) {
      played.push(track);
    },
    stop() {
      this.stops += 1;
    },
  };
}

describe("gains", () => {
  test("decibels convert to the linear gain a bus applies", () => {
    expect(gainFor(0)).toBe(1);
    expect(gainFor(MUSIC_GAIN_DB)).toBeCloseTo(0.2512, 4);
    expect(gainFor(SFX_GAIN_DB)).toBeCloseTo(0.5012, 4);
  });
});

describe("choosing a bed", () => {
  test("a location names its track", () => {
    expect(musicFor({ music: "audio/kln_1963.wav" })).toBe("audio/kln_1963.wav");
  });

  test("no field, an empty field, or no location all mean silence", () => {
    expect(musicFor({})).toBe("");
    expect(musicFor({ music: "   " })).toBe("");
    expect(musicFor(null)).toBe("");
    expect(musicFor(undefined)).toBe("");
    expect(musicFor({ music: 42 })).toBe("");
  });
});

describe("entering locations", () => {
  test("starts the bed the location names", () => {
    const sink = recordingSink();
    const director = new AudioDirector(sink);

    expect(director.enterLocation({ music: "audio/kln_1963.wav" })).toBe("audio/kln_1963.wav");
    expect(sink.played).toEqual(["audio/kln_1963.wav"]);
  });

  test("re-entering the same street does not restart its bed", () => {
    const sink = recordingSink();
    const director = new AudioDirector(sink);

    director.enterLocation({ music: "audio/kln_1963.wav" });
    director.enterLocation({ music: "audio/kln_1963.wav" });

    expect(sink.played).toEqual(["audio/kln_1963.wav"]);
  });

  test("a location with no music leaves the current bed playing", () => {
    const sink = recordingSink();
    const director = new AudioDirector(sink);

    director.enterLocation({ music: "audio/kln_1963.wav" });
    director.enterLocation({}); // e.g. a room with no ambience authored yet

    expect(director.currentTrack).toBe("audio/kln_1963.wav");
    expect(sink.played).toEqual(["audio/kln_1963.wav"]);
  });

  test("moving between streets switches the bed", () => {
    const sink = recordingSink();
    const director = new AudioDirector(sink);

    director.enterLocation({ music: "audio/kln_1955.wav" });
    director.enterLocation({ music: "audio/ssp_2027.wav" });

    expect(sink.played).toEqual(["audio/kln_1955.wav", "audio/ssp_2027.wav"]);
  });

  test("stopping clears the track so a return restarts the bed", () => {
    const sink = recordingSink();
    const director = new AudioDirector(sink);

    director.enterLocation({ music: "audio/ssp_2027.wav" });
    director.stop();
    director.enterLocation({ music: "audio/ssp_2027.wav" });

    expect(sink.stops).toBe(1);
    expect(sink.played).toEqual(["audio/ssp_2027.wav", "audio/ssp_2027.wav"]);
  });
});
