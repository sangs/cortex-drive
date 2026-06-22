"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Subtitles,
  Maximize,
  Minimize,
  RotateCcw,
} from "lucide-react";

interface VideoItem {
  src: string;
  title: string;
  label: string;
}

interface VideoPlayerProps {
  videos: VideoItem[];
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function VideoPlayer({ videos }: VideoPlayerProps) {
  const [videoIndex, setVideoIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showCCTooltip, setShowCCTooltip] = useState(false);
  // pendingNext: set when a mid-playlist video ends. Nothing auto-plays — user must engage.
  const [pendingNext, setPendingNext] = useState<number | null>(null);
  // isEnded: set when the final video finishes. Shows a replay/restart overlay.
  const [isEnded, setIsEnded] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const volumeAreaRef = useRef<HTMLDivElement>(null);
  const hideVolumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goToVideo = useCallback((index: number) => {
    setVideoIndex(index);
    setPendingNext(null);
    setIsEnded(false);
    setCurrentTime(0);
    setDuration(0);
  }, []);

  // Auto-play only when the user explicitly navigates (tab click or end-card "Play").
  // Does NOT fire on initial mount because hasStarted is false then.
  useEffect(() => {
    if (hasStarted && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, [videoIndex, hasStarted]);

  // Sync video muted/volume when state changes
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = isMuted;
      videoRef.current.volume = volume;
    }
  }, [isMuted, volume]);

  // Fullscreen change listener
  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const handleStart = useCallback(() => {
    setHasStarted(true);
    setIsPlaying(true);
    videoRef.current?.play().catch(() => {});
  }, []);

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
    } else {
      video.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [isPlaying]);

  const handleTimeUpdate = useCallback(() => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
  }, []);

  // On end: highlight the next video but do not play it.
  // For the final video, show a replay/restart overlay instead.
  const handleVideoEnded = useCallback(() => {
    setIsPlaying(false);
    if (videoIndex < videos.length - 1) {
      setPendingNext(videoIndex + 1);
    } else {
      setIsEnded(true);
    }
  }, [videoIndex, videos.length]);

  const handleReplay = useCallback(() => {
    setPendingNext(null);
    setIsEnded(false);
    const video = videoRef.current;
    if (video) {
      video.currentTime = 0;
      video.play().catch(() => {});
      setIsPlaying(true);
    }
  }, []);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const time = Number(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setVolume(v);
    if (v === 0) setIsMuted(true);
    else if (isMuted) setIsMuted(false);
  }, [isMuted]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  const showVolume = useCallback(() => {
    if (hideVolumeTimer.current) clearTimeout(hideVolumeTimer.current);
    setShowVolumeSlider(true);
  }, []);

  const scheduleHideVolume = useCallback(() => {
    hideVolumeTimer.current = setTimeout(() => setShowVolumeSlider(false), 300);
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const effectiveVolume = isMuted ? 0 : volume;

  return (
    <div
      ref={containerRef}
      className="aspect-video bg-slate-950 rounded-xl relative overflow-hidden group/player"
    >
      {/* Video element */}
      <video
        ref={videoRef}
        key={videoIndex}
        src={videos[videoIndex].src}
        className={`w-full h-full object-contain transition-opacity duration-300 ${
          hasStarted ? "opacity-100" : "opacity-0"
        }`}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleVideoEnded}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        playsInline
      />

      {/* ── Pre-play overlay ── */}
      {!hasStarted && (
        <button
          className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-slate-950 group/play"
          onClick={handleStart}
        >
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/10 to-transparent pointer-events-none" />
          <div className="w-24 h-24 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center border border-white/20 group-hover/play:scale-110 group-hover/play:bg-white/20 transition-all duration-300">
            <Play className="text-white fill-white w-10 h-10 ml-1" />
          </div>
          <p className="text-sm font-black text-white uppercase tracking-[0.2em]">
            Watch CortexDrive in Action
          </p>
        </button>
      )}

      {/* ── End-card overlay: shown when a video finishes and there is a next one ── */}
      {pendingNext !== null && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 bg-slate-950/88 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-center px-10">
            <p className="text-[10px] uppercase tracking-[0.25em] text-white/40 font-black">
              Up Next
            </p>
            <p className="text-white text-base font-bold leading-snug">
              {videos[pendingNext].label}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleReplay}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest text-white/50 bg-white/10 hover:bg-white/20 hover:text-white/80 transition-all"
            >
              <RotateCcw className="w-3 h-3" />
              Replay
            </button>
            <button
              onClick={() => goToVideo(pendingNext)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-[10px] font-black uppercase tracking-widest text-white bg-primary hover:bg-primary/80 transition-colors"
            >
              <Play className="w-3 h-3 fill-white" />
              Play
            </button>
          </div>
        </div>
      )}

      {/* ── Final-video end overlay ── */}
      {isEnded && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 bg-slate-950/88 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-center px-10">
            <p className="text-[10px] uppercase tracking-[0.25em] text-white/40 font-black">
              That&apos;s everything
            </p>
            <p className="text-white text-base font-bold leading-snug">
              {videos[videoIndex].label}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleReplay}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest text-white/50 bg-white/10 hover:bg-white/20 hover:text-white/80 transition-all"
            >
              <RotateCcw className="w-3 h-3" />
              Replay
            </button>
            {videos.length > 1 && (
              <button
                onClick={() => goToVideo(0)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-[10px] font-black uppercase tracking-widest text-white bg-primary hover:bg-primary/80 transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                Watch from start
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Top bar: title (left) + volume & CC (right) ── */}
      {hasStarted && (
        <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-5 pt-4 pb-8 bg-gradient-to-b from-black/65 to-transparent pointer-events-none z-10">
          <span className="text-white text-sm font-bold drop-shadow-md leading-tight max-w-[60%] truncate">
            {videos[videoIndex].label}
          </span>

          <div className="flex items-center gap-2 pointer-events-auto">
            {/* Volume control */}
            <div
              ref={volumeAreaRef}
              className="relative flex items-center gap-1"
              onMouseEnter={showVolume}
              onMouseLeave={scheduleHideVolume}
            >
              {showVolumeSlider && (
                <div
                  className="absolute right-7 top-1/2 -translate-y-1/2 flex items-center bg-slate-900/90 rounded-full px-3 py-1.5 shadow-xl"
                  onMouseEnter={showVolume}
                  onMouseLeave={scheduleHideVolume}
                >
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={effectiveVolume}
                    onChange={handleVolumeChange}
                    className="w-20 h-1 accent-white cursor-pointer"
                  />
                </div>
              )}
              <button
                onClick={toggleMute}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-white"
                title={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-4 h-4" />
                ) : (
                  <Volume2 className="w-4 h-4" />
                )}
              </button>
            </div>

            {/* CC button */}
            <div className="relative">
              <button
                onClick={() => setShowCCTooltip((v) => !v)}
                className="p-1.5 rounded-lg bg-white/10 opacity-50 cursor-default text-white"
                title="Captions not available"
              >
                <Subtitles className="w-4 h-4" />
              </button>
              {showCCTooltip && (
                <div className="absolute top-9 right-0 bg-slate-900/95 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg whitespace-nowrap shadow-xl">
                  Captions not available
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Bottom bar: progress + controls ── */}
      {hasStarted && (
        <div
          className={`absolute bottom-0 left-0 right-0 px-5 pb-4 pt-10 bg-gradient-to-t from-black/75 to-transparent z-10 transition-opacity duration-200 ${
            !isPlaying ? "opacity-100" : "opacity-0 group-hover/player:opacity-100"
          }`}
        >
          {/* Seekable progress bar */}
          <div className="relative w-full mb-3">
            <div className="w-full h-1 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-white rounded-full"
                style={{ width: `${progress}%` }}
              />
            </div>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
            />
          </div>

          {/* Controls row */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <button
                onClick={togglePlayPause}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-white shrink-0"
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4 fill-white" />
                ) : (
                  <Play className="w-4 h-4 fill-white ml-px" />
                )}
              </button>

              <span className="text-[11px] font-bold text-white/80 tabular-nums shrink-0">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              {/* Playlist tabs — show title, not just number; pulse when pending */}
              <div className="flex items-center gap-1.5 shrink-0">
                {videos.map((v, i) => (
                  <button
                    key={i}
                    onClick={() => goToVideo(i)}
                    title={v.label}
                    className={`px-2.5 py-1 rounded-md text-[9px] font-black uppercase tracking-widest transition-all max-w-[88px] truncate ${
                      i === videoIndex
                        ? "bg-primary text-white"
                        : i === pendingNext
                        ? "bg-white/10 text-white ring-1 ring-primary animate-pulse"
                        : "bg-white/10 text-slate-300 hover:bg-white/20"
                    }`}
                  >
                    {i + 1} · {v.title}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={toggleFullscreen}
              className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-white shrink-0"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? (
                <Minimize className="w-4 h-4" />
              ) : (
                <Maximize className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
