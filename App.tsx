import { requestRecordingPermissionsAsync, useAudioStream } from 'expo-audio';
import type { AudioStreamBuffer, AudioStreamStatus } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

// Repro for https://github.com/expo/expo/issues/52262
//
// Android AudioStream posts its events to the main queue and reads the state
// when the event runs, not when it was queued.
//
// Case 1: start() then stop() right away. Expected status events: [true, false].
//         Actual on Android: [false, false].
// Case 2: let one buffer arrive, then stop() and start() back to back.
//         Expected: no buffer from the old session after the restart.
//         Actual on Android: the old session's buffer is delivered after start().

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const { stream } = useAudioStream({ sampleRate: 16000, channels: 1, encoding: 'int16' });
  const [log, setLog] = useState<string[]>([]);
  const statuses = useRef<boolean[]>([]);
  const buffers = useRef<{ session: number; timestamp: number; arrivedAt: number }[]>([]);
  const session = useRef(0);

  const print = (line: string) => setLog((l) => [...l, line]);

  useEffect(() => {
    const s = stream.addListener('audioStreamStatus', (e: AudioStreamStatus) => {
      statuses.current.push(e.isStreaming);
    });
    const b = stream.addListener('audioStreamBuffer', (e: AudioStreamBuffer) => {
      buffers.current.push({ session: session.current, timestamp: e.timestamp, arrivedAt: Date.now() });
    });
    return () => {
      s.remove();
      b.remove();
    };
  }, [stream.id]);

  const start = () => {
    session.current += 1;
    stream.start();
  };

  const case1 = async () => {
    setLog([]);
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) return print('microphone permission denied');
      statuses.current = [];
      start();
      stream.stop();
      await wait(500);
      const got = JSON.stringify(statuses.current);
      print(`Case 1: start() then stop()`);
      print(`expected status events: [true,false]`);
      print(`actual status events:   ${got}`);
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
      start();
      const first = session.current;
      // wait for the first PCM buffer of this session
      const until = Date.now() + 3000;
      while (buffers.current.length === 0 && Date.now() < until) await wait(20);
      if (buffers.current.length === 0) return print('no buffer arrived in 3 s, is the mic available?');
      // restart back to back
      stream.stop();
      start();
      const second = session.current;
      const restartedAt = Date.now();
      await wait(400);
      stream.stop();
      await wait(300);
      // The native side measures `timestamp` from the start of the session that recorded the
      // buffer. A buffer that arrives after start() #2 with a timestamp larger than the time since
      // the restart cannot belong to session #2.
      const afterRestart = buffers.current
        .filter((x) => x.session === second)
        .map((x) => ({ timestamp: +x.timestamp.toFixed(3), sinceRestart: +((x.arrivedAt - restartedAt) / 1000).toFixed(3) }));
      const stale = afterRestart.filter((x) => x.timestamp > x.sinceRestart + 0.03);
      print(`Case 2: buffer, then stop() + start()`);
      print(`sessions: first=${first} second=${second}`);
      print(`buffers delivered after restart: ${afterRestart.length}`);
      print(`from the stopped session: ${stale.length}`);
      afterRestart.slice(0, 3).forEach((x, i) => print(`  #${i + 1} timestamp=${x.timestamp}s arrived ${x.sinceRestart}s after restart`));
      print(stale.length === 0 ? 'PASS' : 'FAIL');
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
