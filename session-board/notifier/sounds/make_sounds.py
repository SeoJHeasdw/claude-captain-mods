#!/usr/bin/env python3
"""Synthesizes the board's two banner sounds, written next to this script:

  done.wav  a brass fanfare, three quick G4s and a held C major chord: a session finished
  call.wav  a two-note bell, high then low, like a doorbell (E6 C6): a session waits on you

Change a note, a time or a level below, run this again, then run ../build.sh to bake them in.
Any .wav of your own under the same name works as well (30 seconds at most).
"""
import math
import os
import random
import struct
import wave

RATE = 44100
HERE = os.path.dirname(os.path.abspath(__file__))

C4, G4, C5, E5, G5, C6, E6 = 261.63, 392.00, 523.25, 659.26, 783.99, 1046.50, 1318.51

# (frequency ratio, gain, decay scale) per partial.
BELL = [(0.5, 0.15, 1.3), (1.0, 1.0, 1.0), (2.0, 0.5, 0.7), (2.76, 0.25, 0.45), (5.4, 0.1, 0.25)]


def blow(buf, start, length, freq, level, vibrato=0.0, release=0.12):
    """
    Adds one brass note held for `length` seconds: every harmonic up to 8 kHz, bright as it
    speaks and mellower as it holds, with a second voice a few cents sharp for an ensemble.
    """
    first = int(start * RATE)
    attack = 0.03
    for detune, gain in [(1.0, 1.0), (1.003, 0.5)]:
        phase = 0.0
        for i in range(min(int((length + release) * RATE), len(buf) - first)):
            t = i / RATE
            swing = vibrato * math.sin(2 * math.pi * 5.5 * t) * min(1.0, max(0.0, t - 0.2) / 0.3)
            phase += 2 * math.pi * freq * detune * (1 + swing) / RATE
            if t < attack:
                amp = t / attack
            elif t < length:
                amp = 0.85 + 0.15 * math.exp(-(t - attack) / 0.08)
            else:
                amp = 0.85 * 0.5 * (1 + math.cos(math.pi * (t - length) / release))
            dark = 0.35 - 0.2 * math.exp(-t / 0.06)
            ring = sum(
                math.sin(n * phase) * math.exp(-(n - 1) * dark) / n
                for n in range(1, int(8000 / freq) + 1)
            )
            buf[first + i] += level * gain * amp * ring


def shimmer(buf, start, level, decay=0.4):
    """Adds a soft cymbal-like wash: noise with its lows taken off, dying away."""
    noise = random.Random(7)
    first = int(start * RATE)
    last = 0.0
    for i in range(min(int(decay * 6 * RATE), len(buf) - first)):
        x = noise.uniform(-1, 1)
        buf[first + i] += level * (x - last) * math.exp(-(i / RATE) / decay)
        last = x


def strike(buf, start, freq, partials, decay, level, attack=0.004):
    """Adds one struck note to `buf` at `start` seconds, ringing out over about `decay` * 7."""
    first = int(start * RATE)
    for i in range(min(int(decay * 7 * RATE), len(buf) - first)):
        t = i / RATE
        ring = sum(
            gain * math.sin(2 * math.pi * freq * ratio * t) * math.exp(-t / (decay * scale))
            for ratio, gain, scale in partials
        )
        buf[first + i] += level * min(1.0, t / attack) * ring


def reverb(dry, wet):
    """A small Schroeder room: four combs in parallel, then two allpasses."""
    room = [0.0] * len(dry)
    for delay, feedback in [(1557, 0.84), (1617, 0.83), (1491, 0.82), (1422, 0.81)]:
        line = [0.0] * len(dry)
        for i, x in enumerate(dry):
            line[i] = x + (feedback * line[i - delay] if i >= delay else 0.0)
            room[i] += line[i] / 4
    for delay, gain in [(225, 0.5), (556, 0.5)]:
        out = [0.0] * len(room)
        for i, x in enumerate(room):
            back = i - delay
            out[i] = -gain * x + (room[back] + gain * out[back] if back >= 0 else 0.0)
        room = out

    return [(1 - wet) * d + wet * r for d, r in zip(dry, room)]


def write(name, buf, peak=0.6, fade=0.15):
    tail = int(fade * RATE)
    for i in range(tail):
        buf[len(buf) - tail + i] *= 1 - i / tail
    scale = peak / max(abs(x) for x in buf)
    with wave.open(os.path.join(HERE, name), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(b"".join(struct.pack("<h", int(x * scale * 32767)) for x in buf))
    print(f"{name}: {len(buf) / RATE:.2f}s")


done = [0.0] * int(1.5 * RATE)
for start in (0.00, 0.12, 0.24):
    blow(done, start, 0.08, G4, 0.8, release=0.03)
for freq, level in [(C4, 0.45), (C5, 0.8), (E5, 0.7), (G5, 0.75)]:
    blow(done, 0.38, 0.5, freq, level, vibrato=0.004 if freq == G5 else 0.0, release=0.22)
shimmer(done, 0.38, 0.12, decay=0.3)
write("done.wav", reverb(done, 0.2))

call = [0.0] * int(2.0 * RATE)
strike(call, 0.00, E6, BELL, 0.60, 1.0)
strike(call, 0.38, C6, BELL, 0.60, 0.9)
write("call.wav", reverb(call, 0.15))
