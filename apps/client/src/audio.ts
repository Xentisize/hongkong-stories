/**
 * Location music (`audio.gd`, PLAN §6.2).
 *
 * A location names its bed with a `music` field such as `audio/kln_1963.wav`. The policy is small
 * but it is policy: an empty field means *leave whatever is playing*, and re-entering the same
 * location must not restart the bed from the top — which in Godot was `_current_music` and a
 * comparison, and here is the same comparison against a swap-friendly sink.
 *
 * The sink is injected so the decisions are testable without an `AudioContext`. The browser sink
 * decodes the file once and plays it with `loop = true`: a buffer source loop is sample-accurate,
 * where an `<audio loop>` restarts with an audible gap — the same reason `audio.gd` sets
 * `LOOP_FORWARD` with explicit loop points rather than relying on a player default.
 */

/** `audio.gd`'s `MUSIC_DB`. */
export const MUSIC_GAIN_DB = -12;

/** `audio.gd`'s `SFX_DB`. */
export const SFX_GAIN_DB = -6;

/** Decibels to a linear gain multiplier, as an audio bus applies them. */
export function gainFor(decibels: number): number {
  return 10 ** (decibels / 20);
}

/** The track a location asks for; `""` means "keep whatever is playing". */
export function musicFor(location: { music?: unknown } | null | undefined): string {
  const track = location?.music;
  return typeof track === "string" ? track.trim() : "";
}

export interface AudioSink {
  /** Start (or switch to) a loop. Called only when the track actually changes. */
  play(track: string): void;
  stop(): void;
  /** 0..1, from the music bus. */
  setVolume?(gain: number): void;
}

export class AudioDirector {
  private current = "";

  constructor(private readonly sink: AudioSink) {}

  /** The track currently playing, or `""`. */
  get currentTrack(): string {
    return this.current;
  }

  /**
   * Entering a location: start its bed unless it asks for nothing or is already playing.
   *
   * Returns the track now playing, which is the value a caller can assert on.
   */
  enterLocation(location: { music?: unknown } | null | undefined): string {
    const track = musicFor(location);
    if (track === "" || track === this.current) return this.current;

    this.current = track;
    this.sink.play(track);
    return this.current;
  }

  /** Mute for a pause or a cutscene; the track stays current so returning resumes nothing. */
  stop(): void {
    this.current = "";
    this.sink.stop();
  }
}

/**
 * The browser sink: one decoded buffer per track, looped sample-accurately.
 *
 * Decoding is lazy and cached because a 4 MB WAV bed is not worth decoding twice when a player
 * walks between two streets that share it. Failures are swallowed into `null`: a missing bed is a
 * quiet street, not a broken game.
 */
export class WebAudioSink implements AudioSink {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer | null>();
  private volume = gainFor(MUSIC_GAIN_DB);

  constructor(
    private readonly resolveUrl: (track: string) => string = (track) => track,
    private readonly createContext: () => AudioContext = () => new AudioContext(),
  ) {}

  setVolume(gain: number): void {
    this.volume = gain;
    if (this.gain) this.gain.gain.value = gain;
  }

  play(track: string): void {
    void this.start(track);
  }

  stop(): void {
    this.source?.stop();
    this.source = null;
  }

  private async start(track: string): Promise<void> {
    const buffer = await this.buffer(track);
    if (buffer === null) return;

    // Constructed on the first play, which happens after the click that dismisses the title: a
    // context created before a gesture starts suspended and stays silent.
    this.context ??= this.createContext();
    if (this.context.state === "suspended") await this.context.resume().catch(() => undefined);

    this.source?.stop();

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    // The gain node is recreated with the context, so a late `setVolume` still applies.
    this.gain ??= this.context.createGain();
    this.gain.gain.value = this.volume;

    source.connect(this.gain);
    this.gain.connect(this.context.destination);
    source.start();

    this.source = source;
  }

  private async buffer(track: string): Promise<AudioBuffer | null> {
    if (this.buffers.has(track)) return this.buffers.get(track) ?? null;

    try {
      const response = await fetch(this.resolveUrl(track));
      if (!response.ok) throw new Error(`${response.status}`);
      const bytes = await response.arrayBuffer();
      this.context ??= this.createContext();
      const decoded = await this.context.decodeAudioData(bytes);
      this.buffers.set(track, decoded);
      return decoded;
    } catch {
      // Cache the miss too: a bed that 404s should not be requested on every location change.
      this.buffers.set(track, null);
      return null;
    }
  }
}
