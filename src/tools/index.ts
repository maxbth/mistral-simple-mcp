import complete from './complete';
import extract from './extract';
import transcribe from './transcribe';
import type {ToolModule} from './types';

export const TOOLS: Array<ToolModule> = [complete, extract, transcribe];
