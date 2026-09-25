import type { Signature } from '@dispatch/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { toSignature, type Stroke } from '../signature';

function pathOf(stroke: Stroke): string {
  return stroke
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.y)}`)
    .join(' ');
}

/** The recipient signs with a finger; the strokes become the signature sent with the proof. */
export function SignaturePad({ onChange }: { onChange: (signature: Signature | null) => void }) {
  const [drawn, setDrawn] = useState<Stroke[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const point = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
          setDrawn((previous) => [...previous, [point]]);
        },
        onPanResponderMove: (event) => {
          const point = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
          setDrawn((previous) => [...previous.slice(0, -1), [...(previous.at(-1) ?? []), point]]);
        },
      }),
    [],
  );

  // The parent always holds the signature as the API will receive it.
  const signature = useMemo(() => toSignature(drawn, size.width, size.height), [drawn, size]);
  useEffect(() => {
    onChange(signature);
  }, [signature, onChange]);

  return (
    <View>
      <View
        style={styles.pad}
        onLayout={(event: LayoutChangeEvent) => {
          setSize({
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height,
          });
        }}
        accessibilityLabel="Signature pad"
        {...responder.panHandlers}
      >
        <Svg width="100%" height="100%">
          {drawn.map((stroke, index) => (
            <Path
              key={index}
              d={pathOf(stroke)}
              stroke="#0d2b5e"
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
            />
          ))}
        </Svg>
      </View>
      <Pressable onPress={() => setDrawn([])} accessibilityRole="button">
        <Text style={styles.clear}>Clear signature</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: {
    height: 180,
    borderWidth: 1,
    borderColor: '#d1d9e0',
    borderStyle: 'dashed',
    borderRadius: 8,
    backgroundColor: '#ffffff',
  },
  clear: { color: '#0b57d0', paddingVertical: 8 },
});
