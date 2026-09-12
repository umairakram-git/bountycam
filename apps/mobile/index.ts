import 'react-native-get-random-values';
import { Buffer } from 'buffer';
(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;

import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
