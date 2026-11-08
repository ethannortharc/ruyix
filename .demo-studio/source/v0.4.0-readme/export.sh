#!/bin/bash
# README media from the captures: stills scaled to 2000 px wide and palette-compressed; the two clips cut and made
# into GIFs. Needs ffmpeg, gifski, pngquant.
#   export.sh <capture-dir> <out-dir> <lang>
set -euo pipefail
cap="$1/$3"; out="$2/$3"; lang="$3"
mkdir -p "$out"
tmp=$(mktemp -d -t ruyix-media); trap 'rm -rf "$tmp"' EXIT

still() { # still <name> [crop-height-px]
  local vf="scale=2000:-1:flags=lanczos"
  [ -n "${2:-}" ] && vf="crop=3200:$2:0:0,$vf"
  ffmpeg -v error -y -i "$cap/$1.png" -vf "$vf" "$tmp/$1.png"
  pngquant --quality 80-96 --strip --force --output "$out/$1.png" "$tmp/$1.png"
}
still hero
still run 1720      # the window, without the dock under it
still review 1720

gif() { # gif <name> <filter_complex ending in [v]> <fps> <width>
  rm -rf "$tmp/f"; mkdir -p "$tmp/f"
  ffmpeg -v error -y -i "$cap/$1.webm" -filter_complex "$2" -map '[v]' "$tmp/f/%04d.png"
  gifski --quiet --fps "$3" --width "$4" --quality 82 -o "$out/$1.gif" "$tmp"/f/*.png
}
# customize: from a clean desk (the old card discarded) to the new theme settled
if [ "$lang" = en ]; then from=7.0; to=17.5; else from=7.5; to=18.0; fi
gif customize "[0]trim=$from:$to,setpts=PTS-STARTPTS,fps=12[v]" 12 1100
# maps: three seconds of each map
gif maps "[0]split=3[a][b][c];[a]trim=4:7,setpts=PTS-STARTPTS[x];[b]trim=10:13,setpts=PTS-STARTPTS[y];[c]trim=18:21,setpts=PTS-STARTPTS[z];[x][y][z]concat=n=3:v=1:a=0,fps=10[v]" 10 1100
ls -l "$out"
