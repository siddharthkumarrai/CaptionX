import { useState } from "react";

// Shared caption-edit operations for the studio (Timing step + preview).
// All mutations flow through onSaveTranscript(words, phrases) — the same
// contract PreviewPanel always used — so preview, backend, and render stay
// consistent no matter which surface made the edit.
const round4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

function normalize(next) {
  return next
    .filter((p) => p.words.length > 0)
    .sort((a, b) => a.start - b.start)
    .map((p) => ({
      ...p,
      start: p.words[0].start,
      end: p.words[p.words.length - 1].end,
      duration: round4(p.words[p.words.length - 1].end - p.words[0].start),
      phrase: p.words.map((w) => w.word).join(" "),
    }));
}

export default function useCaptionEdits({ jobResult, onSaveTranscript, fps = 30 }) {
  const [saveMsg, setSaveMsg] = useState("");
  const [saveError, setSaveError] = useState("");
  const phrases = jobResult?.phrases || [];

  function commit(next) {
    if (!onSaveTranscript) return;
    const sorted = normalize(next);
    const words = sorted.flatMap((p) => p.words.map((w) => ({ ...w })));
    Promise.resolve(onSaveTranscript(words, sorted))
      .then((res) => {
        if (res && res.synced === false) {
          setSaveMsg("Saved in the panel — backend sync failed, render uses the last synced transcript.");
        } else {
          setSaveMsg("Saved — preview & render use these captions.");
        }
        setSaveError("");
      })
      .catch(() => { setSaveError("Could not save caption edits — check the backend."); setSaveMsg(""); });
  }

  const frame = 1 / (Number(fps) > 0 ? Number(fps) : 30);
  const snap = (t) => Math.round(t / frame) * frame;

  function insertPhraseAt(t, text = "New caption") {
    t = Math.max(0, t);
    const next = phrases.find((p) => p.start > t + 0.01);
    const end = next ? Math.min(t + 1.2, next.start) : t + 1.2;
    const half = (end - t) / 2;
    const words = text.split(/\s+/).filter(Boolean);
    const per = (end - t) / Math.max(1, words.length);
    const np = {
      phrase: text,
      words: words.map((word, k) => ({
        word, start: round4(t + k * per), end: round4(t + (k + 1) * per), score: 1,
      })),
      start: round4(t),
      end: round4(end),
      duration: round4(end - t),
    };
    const idx = phrases.findIndex((p) => p.start > t + 0.01);
    commit(idx === -1 ? [...phrases, np] : [...phrases.slice(0, idx), np, ...phrases.slice(idx)]);
    return t;
  }

  function splitPhraseAt(pi, wi) {
    const target = phrases[pi];
    if (!target || !target.words.length || wi >= target.words.length - 1) return;
    const a = { ...target, words: target.words.slice(0, wi + 1).map((w) => ({ ...w })) };
    const bWords = target.words.slice(wi + 1).map((w) => ({ ...w }));
    const b = { phrase: "", words: bWords, start: bWords[0].start, end: target.end, duration: 0 };
    commit(phrases.flatMap((p, i) => (i === pi ? [a, b] : [p])));
  }

  function deletePhrase(pi) {
    commit(phrases.filter((_, i) => i !== pi));
  }

  function mergeWithNext(pi) {
    const a = phrases[pi];
    const b = phrases[pi + 1];
    if (!a || !b) return;
    commit(phrases.flatMap((p, i) => (i === pi ? [{ ...a, words: [...a.words, ...b.words.map((w) => ({ ...w }))] }] : i === pi + 1 ? [] : [p])));
  }

  function editWord(pi, wi, patch) {
    commit(phrases.map((p, i) => (i === pi ? { ...p, words: p.words.map((w, j) => (j === wi ? { ...w, ...patch } : w)) } : p)));
  }

  function nudgeWord(pi, wi, dStart, dEnd) {
    const w = phrases[pi]?.words[wi];
    if (!w) return;
    const start = Math.max(0, round4(snap(w.start + dStart)));
    const end = Math.max(round4(start + frame), round4(snap(w.end + dEnd)));
    editWord(pi, wi, { start, end });
  }

  function deleteWord(pi, wi) {
    const target = phrases[pi];
    if (!target) return;
    const words = target.words.filter((_, j) => j !== wi);
    if (!words.length) {
      deletePhrase(pi);
      return;
    }
    commit(phrases.map((p, i) => (i === pi ? { ...p, words } : p)));
  }

  function addWord(pi, wiAfter, text, atTime) {
    const target = phrases[pi];
    if (!target) return;
    const anchor = target.words[wiAfter] || target.words[target.words.length - 1];
    const t = Math.max(0, Number(atTime ?? (anchor ? anchor.end : target.start)) || 0);
    const entry = { word: text || "new", start: round4(t), end: round4(t + Math.max(frame * 2, 0.3)), score: 1 };
    const words = [...target.words.slice(0, wiAfter + 1), entry, ...target.words.slice(wiAfter + 1)];
    commit(phrases.map((p, i) => (i === pi ? { ...p, words } : p)));
  }

  function setPhraseBounds(pi, start, end) {
    const target = phrases[pi];
    if (!target || !target.words.length) return;
    const words = target.words.map((w) => ({ ...w }));
    if (start != null) words[0] = { ...words[0], start: Math.max(0, Number(start) || 0) };
    if (end != null) words[words.length - 1] = { ...words[words.length - 1], end: Math.max(words[0].start + frame, Number(end) || 0) };
    commit(phrases.map((p, i) => (i === pi ? { ...p, words } : p)));
  }

  return {
    phrases, saveMsg, saveError,
    commit, insertPhraseAt, splitPhraseAt, deletePhrase, mergeWithNext,
    editWord, nudgeWord, deleteWord, addWord, setPhraseBounds, frame,
  };
}
