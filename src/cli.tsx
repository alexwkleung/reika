#!/usr/bin/env node
import { render } from 'ink';
import { App } from './ui/App.js';

render(<App />, { exitOnCtrlC: false });
