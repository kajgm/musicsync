//! musicsync loopback agent helper: capture what the PC is playing (WASAPI loopback on an
//! output device) and write it to stdout as mono f32 little-endian PCM. stderr carries one JSON object
//! per line: a header first, then stats every 2 s. No audio is stored anywhere.
//!
//!   loopback.exe                   capture the default output device
//!   loopback.exe --list            list output devices
//!   loopback.exe --device <text>   capture the first output device whose name contains <text>

use std::io::{self, Write};
use std::sync::mpsc::{self, SyncSender};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{InputCallbackInfo, SampleFormat, StreamConfig};

struct Chunk {
    samples: Vec<f32>,
    /// Time between capture and our callback, from cpal's stream timestamps.
    capture_to_callback_ms: f64,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{{\"error\":\"{}\"}}", json_escape(&err.to_string()));
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let host = cpal::default_host();

    if args.iter().any(|a| a == "--list") {
        for device in host.output_devices()? {
            println!("{}", device.name().unwrap_or_else(|_| "?".into()));
        }
        return Ok(());
    }

    let device = match args.iter().position(|a| a == "--device").and_then(|i| args.get(i + 1)) {
        Some(needle) => {
            let needle = needle.to_lowercase();
            host.output_devices()?
                .find(|d| d.name().map(|n| n.to_lowercase().contains(&needle)).unwrap_or(false))
                .ok_or("no output device matches --device")?
        }
        None => host.default_output_device().ok_or("no default output device")?,
    };

    // Opening an output device as an input makes cpal's WASAPI host use loopback mode.
    let supported = device.default_output_config()?;
    let channels = supported.channels() as usize;
    let sample_rate = supported.sample_rate().0;
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();

    let (tx, rx) = mpsc::sync_channel::<Chunk>(256);
    let on_error = |err: cpal::StreamError| {
        eprintln!("{{\"streamError\":\"{}\"}}", json_escape(&err.to_string()));
    };

    let stream = match format {
        SampleFormat::F32 => {
            let tx = tx.clone();
            device.build_input_stream(
                &config,
                move |data: &[f32], info: &InputCallbackInfo| forward(data, channels, info, &tx, |s| s),
                on_error,
                None,
            )?
        }
        SampleFormat::I16 => {
            let tx = tx.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], info: &InputCallbackInfo| {
                    forward(data, channels, info, &tx, |s| s as f32 / 32768.0)
                },
                on_error,
                None,
            )?
        }
        other => return Err(format!("unsupported sample format {other:?}").into()),
    };
    drop(tx);

    eprintln!(
        "{{\"header\":{{\"device\":\"{}\",\"sampleRate\":{},\"channels\":{},\"format\":\"{:?}\",\"output\":\"f32le mono\"}}}}",
        json_escape(&device.name().unwrap_or_default()),
        sample_rate,
        channels,
        format
    );
    stream.play()?;

    let mut out = io::stdout().lock();
    let mut bytes = Vec::new();
    let (mut callbacks, mut frames, mut latency_sum, mut latency_max) = (0u64, 0u64, 0f64, 0f64);
    let mut last_report = Instant::now();
    loop {
        // Loopback delivers nothing while nothing plays, so wake up for stats anyway.
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(chunk) => {
                bytes.clear();
                for s in &chunk.samples {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                if out.write_all(&bytes).and_then(|_| out.flush()).is_err() {
                    break; // the reader went away
                }
                callbacks += 1;
                frames += chunk.samples.len() as u64;
                latency_sum += chunk.capture_to_callback_ms;
                latency_max = latency_max.max(chunk.capture_to_callback_ms);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if last_report.elapsed() >= Duration::from_secs(2) {
            let n = callbacks.max(1) as f64;
            eprintln!(
                "{{\"stats\":{{\"callbacks\":{},\"framesPerCallback\":{:.0},\"captureToCallbackMsAvg\":{:.2},\"captureToCallbackMsMax\":{:.2}}}}}",
                callbacks,
                frames as f64 / n,
                latency_sum / n,
                latency_max
            );
            (callbacks, frames, latency_sum, latency_max) = (0, 0, 0.0, 0.0);
            last_report = Instant::now();
        }
    }
    Ok(())
}

/// Downmix to mono and hand the block to the writer thread without ever blocking
/// the audio callback (a full queue drops the block instead).
fn forward<T: Copy>(
    data: &[T],
    channels: usize,
    info: &InputCallbackInfo,
    tx: &SyncSender<Chunk>,
    to_f32: impl Fn(T) -> f32,
) {
    let ts = info.timestamp();
    let capture_to_callback_ms = ts
        .callback
        .duration_since(&ts.capture)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    let samples = data
        .chunks_exact(channels)
        .map(|frame| frame.iter().map(|&s| to_f32(s)).sum::<f32>() / channels as f32)
        .collect();
    let _ = tx.try_send(Chunk { samples, capture_to_callback_ms });
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}
