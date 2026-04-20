import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    // The state file is in the root directory, one level up from frontend/
    const rootDir = path.resolve(process.cwd(), '..');
    const statePath = path.join(rootDir, '.yieldsense-state.json');

    if (!fs.existsSync(statePath)) {
      return NextResponse.json(
        { error: 'State file not found', defaultState: true },
        { status: 404 }
      );
    }

    const stateData = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(stateData);

    return NextResponse.json(state);
  } catch (error: any) {
    console.error('Error reading state:', error);
    return NextResponse.json(
      { error: 'Failed to read state', details: error.message },
      { status: 500 }
    );
  }
}
