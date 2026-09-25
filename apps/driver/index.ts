// The background location task must be defined at start-up, before any screen renders, so the
// operating system can wake the app and deliver positions to it.
import './src/location/background-task';
import { registerRootComponent } from 'expo';
import { App } from './src/App';

registerRootComponent(App);
