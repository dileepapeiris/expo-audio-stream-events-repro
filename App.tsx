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
  const buffers = useRef<{ session: number; timestamp: number }[]>([]);
  const session = useRef(0);

  const print = (line: string) => setLog((l) => [...l, line]);

  useEffect(() => {
    const s = stream.addListener('audioStreamStatus', (e: AudioStreamStatus) => {
      statuses.current.push(e.isStreaming);
    });
    const b = stream.addListener('audioStreamBuffer', (e: AudioStreamBuffer) => {
      buffers.current.push({ session: session.current, timestamp: e.timestamp });
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
  };

  const case2 = async () => {
    setLog([]);
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
    // A buffer that reaches JS after start() #2 but whose timestamp is measured from start #1
    // (older than the time elapsed since the restart) belongs to the stopped session.
    const afterRestart = buffers.current.filter((x) => x.session === second);
    const elapsedAtEnd = (Date.now() - restartedAt) / 1000;
    const stale = afterRestart.filter((x) => x.timestamp > elapsedAtEnd + 0.05);
    print(`Case 2: buffer, then stop() + start()`);
    print(`sessions: first=${first} second=${second}`);
    print(`buffers delivered after restart: ${afterRestart.length}`);
    print(`of those, timestamps from the stopped session: ${stale.length}`);
    print(`first delivered after restart: ${JSON.stringify(afterRestart[0] ?? null)}`);
    print(stale.length === 0 ? 'PASS' : 'FAIL');
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
