import { requestRecordingPermissionsAsync, useAudioStream } from 'expo-audio';
import type { AudioStreamBuffer, AudioStreamStatus } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

// Repro for https://github.com/expo/expo/issues/52262
//
// Android AudioStream posts its events to the main queue and reads the state
// when the event runs, not when it was queued.
//
// Case 1: await start(), then stop() right away. Expected status events: [true, false].
//         Actual on Android: [false, false].
// Case 3: a plain stop() still delivers the buffer that was being read.
// Case 2: let one buffer arrive, then stop() and start() back to back.
//         Expected: no buffer from the old session after the restart.
//         Actual on Android: the old session's buffer is delivered after start().

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const { stream } = useAudioStream({ sampleRate: 16000, channels: 1, encoding: 'int16' });
  const [log, setLog] = useState<string[]>([]);
  const statuses = useRef<{ isStreaming: boolean; at: number }[]>([]);
  const tapAt = useRef(0);
  const buffers = useRef<{ session: number; timestamp: number; arrivedAt: number }[]>([]);
  const session = useRef(0);

  const print = (line: string) => setLog((l) => [...l, line]);

  useEffect(() => {
    const s = stream.addListener('audioStreamStatus', (e: AudioStreamStatus) => {
      statuses.current.push({ isStreaming: e.isStreaming, at: Date.now() - tapAt.current });
    });
    const b = stream.addListener('audioStreamBuffer', (e: AudioStreamBuffer) => {
      buffers.current.push({ session: session.current, timestamp: e.timestamp, arrivedAt: Date.now() });
    });
    return () => {
      s.remove();
      b.remove();
    };
  }, [stream.id]);

  // `start()` is an async native function; `stop()` is synchronous.
  const start = async () => {
    session.current += 1;
    await stream.start();
  };

  const case1 = async () => {
    setLog([]);
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) return print('microphone permission denied');
      statuses.current = [];
      tapAt.current = Date.now();
      await start();
      stream.stop();
      await wait(1000);
      const values = statuses.current.map((x) => x.isStreaming);
      const got = JSON.stringify(values);
      print(`Case 1: start() then stop()`);
      print(`expected status events: [true,false]`);
      print(`actual status events:   ${got}`);
      statuses.current.forEach((x, i) => print(`  #${i + 1} isStreaming=${x.isStreaming} arrived ${x.at} ms after the calls`));
      print(got === '[true,false]' ? 'PASS' : 'FAIL');
    } catch (e) {
      print(`error: ${String(e)}`);
    }
  };

  const case2 = async () => {
    setLog([]);
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) return print('microphone permission denied');
      buffers.current = [];
      await start();
      const first = session.current;
      // Record for 1.2 s so every buffer of this session has a timestamp of about 1.2 s or more.
      await wait(1200);
      if (buffers.current.length === 0) return print('no buffer arrived in 1.2 s, is the mic available?');
      // restart back to back
      stream.stop();
      const restartCalledAt = Date.now();
      await start();
      const second = session.current;
      await wait(600);
      stream.stop();
      await wait(300);
      // Buffers that reach JS after stop() was called. In this 0.6 s window a buffer from the new
      // session has a timestamp under 0.9 s; a buffer from the stopped session has about 1.2 s.
      const afterRestart = buffers.current
        .filter((x) => x.arrivedAt >= restartCalledAt && x.session === second)
        .map((x) => ({ timestamp: +x.timestamp.toFixed(3), sinceRestart: +((x.arrivedAt - restartCalledAt) / 1000).toFixed(3) }));
      const stale = afterRestart.filter((x) => x.timestamp > 0.9);
      print(`Case 2: 1.2 s of audio, then stop() + start()`);
      print(`sessions: first=${first} second=${second}`);
      print(`buffers delivered after the restart: ${afterRestart.length}`);
      print(`from the stopped session (timestamp > 0.9 s): ${stale.length}`);
      stale.forEach((x) => print(`  old: timestamp=${x.timestamp}s arrived ${x.sinceRestart}s after stop()`));
      afterRestart.slice(0, 2).forEach((x, i) => print(`  #${i + 1} timestamp=${x.timestamp}s arrived ${x.sinceRestart}s after stop()`));
      print(stale.length === 0 ? 'PASS' : 'FAIL');
    } catch (e) {
      print(`error: ${String(e)}`);
    }
  };

  // A plain stop() must still deliver the buffer that was being read when stop() was called.
  const case3 = async () => {
    setLog([]);
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) return print('microphone permission denied');
      buffers.current = [];
      await start();
      const until = Date.now() + 3000;
      while (buffers.current.length === 0 && Date.now() < until) await wait(20);
      const before = buffers.current.length;
      stream.stop();
      const stoppedAt = Date.now();
      await wait(500);
      const late = buffers.current.filter((x) => x.arrivedAt >= stoppedAt);
      print(`Case 3: plain stop()`);
      print(`buffers before stop: ${before}, delivered after stop: ${late.length}`);
      print(`(the buffer being read at stop() time should still arrive)`);
      print(late.length >= 1 ? 'PASS' : 'FAIL');
    } catch (e) {
      print(`error: ${String(e)}`);
    }
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>expo-audio AudioStream events</Text>
      <View style={styles.buttons}>
        <Button title="Case 1: status after start+stop" onPress={case1} />
        <Button title="Case 2: old buffer after restart" onPress={case2} />
        <Button title="Case 3: last buffer after plain stop" onPress={case3} />
      </View>
      <ScrollView contentContainerStyle={styles.log}>
        {log.map((line, i) => (
          <Text key={i} style={[styles.line, line === 'FAIL' && styles.fail, line === 'PASS' && styles.pass]}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff', paddingTop: 64, paddingHorizontal: 16 },
  title: { fontSize: 20, fontWeight: '600', marginBottom: 16 },
  buttons: { gap: 8, marginBottom: 16 },
  log: { gap: 4 },
  line: { fontFamily: 'Menlo', fontSize: 14 },
  fail: { color: '#c00', fontWeight: '700' },
  pass: { color: '#080', fontWeight: '700' },
});
