---
name: video-editing
description: Plan and revise a Ruyix video edit using inspected source media, a validated edit decision list, a shared frame clock, and human review of rendered previews.
---

# Video editing in Ruyix

Use this skill for the `video.edit` workflow. The native renderer accepts only the
schema in the stage brief. The timeline is data, not executable FFmpeg arguments.

1. Read the brief, source inventory, current timeline, prior review comments and
   the run's preference snapshot. New explicit instructions take precedence over
   remembered preferences. Do not interpret silence or workflow completion as a
   positive rating. Keep a low score's reason and stage attached to its example.
2. Inspect footage before claiming its content. Source durations, dimensions and
   checksums are measured facts; a filename is not evidence of what a scene shows.
   If video inspection is unavailable, preserve a conservative initial assembly
   and explain that it needs human scene selection. Never invent speech/captions.
3. Use existing source IDs, stable unique clip IDs and half-open source ranges
   `[in, out)`. Preserve the person's changes and explain each proposed cut.
   Leave room around words, breaths, actions and sound tails. Silence alone does
   not prove a moment should be deleted. Avoid distracting tiny fragments.
4. The output FPS is the only timeline clock. Each clip duration rounds down to
   complete output frames. Put captions at final-output timestamps after speed
   changes/reordering; re-check every affected cue. The current renderer supports
   hard cuts, speed, gain, contain/cover fitting and optional loudness processing.
   Do not promise transitions, burn-in text, narration, music or generated shots.
5. Save `timeline.json` and explain uncertain/content-dependent decisions in
   `edit-notes.md`. Do not modify source media, the inspected source inventory,
   generated exports, or approval records. Use the person's review to settle
   uncertain editorial choices; never remove review stages to make a run finish.
6. A preview is an actual lower-resolution MP4, not a simulated success. Review
   scene boundaries, visual framing, intelligibility and subtitle synchronization.
   Clearly separate programmatic decode checks from human listening/watching.
7. Preserve versioned artifacts. An edit after preview approval must receive a
   new preview and review before final export. Deliver a browser-playable MP4,
   optional VTT sidecar/soft subtitle track, and its source/timeline/toolchain
   manifest. MP4 delivery does not claim NLE project interchange or publication.

## Research lineage

This is independently written guidance; no upstream skill text or executable
code is vendored. Practices were informed by:

- [Auto-Editor skill](https://github.com/WyattBlue/auto-editor/blob/master/skills/auto-editor/SKILL.md): inspectable first passes, half-open ranges and speech margins.
- [HyperFrames core skill](https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/SKILL.md): deterministic local assets, stable identifiers and explicit timing.
- [HyperFrames review](https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes/references/review.md): inspect scene boundaries and distinguish automated checks from human review.
- [Remotion editable timelines](https://github.com/remotion-dev/skills/blob/main/skills/remotion-markup/video-editing.md): independently editable clips and synchronized timing. The Remotion runtime and its licensing are not dependencies of this pack.

See `docs/research/creator-studios.md` for evaluated implementations, source
licenses, optional future adapters and the product's acceptance criteria.
