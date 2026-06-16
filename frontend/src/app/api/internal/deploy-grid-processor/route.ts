import { NextRequest, NextResponse } from 'next/server';
import { deployAcurastProcessor, parseAcurastDeploymentRequest } from '@/lib/acurastDeploymentAdapter';

function isAuthorized(request: NextRequest) {
  const secret = process.env.ACURAST_GRID_DEPLOYMENT_WEBHOOK_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV === 'development';

  const header = request.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const deploymentRequest = parseAcurastDeploymentRequest(await request.json());
    const deployment = await deployAcurastProcessor('grid', deploymentRequest);
    if (!deployment) {
      return NextResponse.json(
        {
          error:
            'Acurast deployment adapter is not configured. Set ACURAST_DEPLOYMENT_MODE=local for local testing or ACURAST_DEPLOYMENT_ADAPTER_URL for production.',
        },
        { status: 503 }
      );
    }

    return NextResponse.json(deployment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
