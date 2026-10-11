"""Multi-object tracking of defects across frames (ByteTrack-style two-stage association).

Stage 1  high-confidence detections are matched to existing tracks (cost = centre distance,
         gated, with an IoU bonus), greedy on increasing cost.
Stage 2  remaining tracks may be extended by low-confidence detections that overlap them
         (keeps a track alive when the detector's score drops for a few frames: blur, glare).
Births   an unmatched high-confidence detection that overlaps a live track (a fragment of a
         crack seen from far away) is absorbed by it; otherwise it starts a new track.
A track is *confirmed* after several hits over a minimum duration; only confirmed tracks are
reported. Class is decided by vote over the track's history.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .detector import Detection


@dataclass
class Track:
    id: int
    box: list[float]
    votes: dict = field(default_factory=dict)
    conf: float = 0.0
    hits: int = 1
    first_seen: float = 0.0
    last_seen: float = 0.0
    confirmed: bool = False
    # inspection state (set by the mission)
    counted: bool = False
    is_marker: bool = False
    rejected_in: str | None = None
    number: int = 0
    sheet: str | None = None

    @property
    def cls(self) -> str:
        return max(self.votes, key=self.votes.get)

    @property
    def center(self) -> tuple[float, float]:
        return (self.box[0] + self.box[2]) / 2, (self.box[1] + self.box[3]) / 2


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def overlaps(a, b, pad: float) -> bool:
    return a[0] - pad < b[2] + pad and b[0] - pad < a[2] + pad and a[1] - pad < b[3] + pad and b[1] - pad < a[3] + pad


class ByteTracker:
    def __init__(self, high: float = 0.35, gate: float = 0.22, merge_pad: float = 0.04,
                 confirm_hits: int = 3, confirm_time: float = 0.3, visible_for: float = 0.6, forget: float = 2.0):
        self.high = high                  # detections at or above: stage 1 + births
        self.gate = gate                  # max centre motion between frames (fraction of image diagonal)
        self.merge_pad = merge_pad        # fragment absorption distance (fraction of diagonal)
        self.confirm_hits = confirm_hits
        self.confirm_time = confirm_time
        self.visible_for = visible_for    # s a track is still drawn after its last detection
        self.forget = forget              # s before a lost track is deleted (doubled once counted)
        self.tracks: list[Track] = []
        self._next = 1

    def reset(self) -> None:
        self.tracks.clear()
        self._next = 1

    def live(self, t: float) -> list[Track]:
        return [tr for tr in self.tracks if t - tr.last_seen < self.visible_for]

    def _update(self, tr: Track, d: Detection, t: float) -> None:
        k = 0.6
        tr.box = [tr.box[i] + (d.box[i] - tr.box[i]) * k for i in range(4)]
        tr.votes[d.name] = tr.votes.get(d.name, 0) + d.conf
        tr.conf = d.conf
        tr.hits += 1
        tr.last_seen = t
        if not tr.confirmed and tr.hits >= self.confirm_hits and t - tr.first_seen >= self.confirm_time:
            tr.confirmed = True

    def _associate(self, tracks: list[Track], dets: list[Detection], diag: float, need_overlap: bool):
        pairs = []
        for ti, tr in enumerate(tracks):
            tc = tr.center
            for di, d in enumerate(dets):
                dc = d.center
                dist = ((tc[0] - dc[0]) ** 2 + (tc[1] - dc[1]) ** 2) ** 0.5 / diag
                o = iou(tr.box, d.box)
                if need_overlap and o <= 0.0:
                    continue
                if dist <= self.gate or o > 0.1:
                    pairs.append((dist - 0.5 * o, ti, di))
        pairs.sort()
        used_t, used_d, matches = set(), set(), []
        for _, ti, di in pairs:
            if ti in used_t or di in used_d:
                continue
            used_t.add(ti)
            used_d.add(di)
            matches.append((ti, di))
        return matches, used_t, used_d

    def update(self, dets: list[Detection], t: float, size: tuple[int, int]) -> list[Track]:
        diag = (size[0] ** 2 + size[1] ** 2) ** 0.5
        high = [d for d in dets if d.conf >= self.high]
        low = [d for d in dets if d.conf < self.high]
        active = [tr for tr in self.tracks if t - tr.last_seen < self.forget * (2 if tr.counted else 1)]

        matches, used_t, used_h = self._associate(active, high, diag, need_overlap=False)
        for ti, di in matches:
            self._update(active[ti], high[di], t)

        rest = [tr for i, tr in enumerate(active) if i not in used_t]
        matches2, _, _ = self._associate(rest, low, diag, need_overlap=True)
        for ti, di in matches2:
            self._update(rest[ti], low[di], t)

        pad = self.merge_pad * diag
        for di, d in enumerate(high):
            if di in used_h:
                continue
            host = next((tr for tr in active if t - tr.last_seen < self.visible_for and overlaps(d.box, tr.box, pad)), None)
            if host is not None:
                host.last_seen = t
                continue
            self.tracks.append(Track(id=self._next, box=list(d.box), votes={d.name: d.conf}, conf=d.conf,
                                     first_seen=t, last_seen=t))
            self._next += 1

        self.tracks = [tr for tr in self.tracks if t - tr.last_seen < self.forget * (2 if tr.counted else 1)]
        return self.tracks
