import { MODEL_LIST_ERROR_KINDS, type ModelListDiagnostic } from '../../renderer/src/types'
import { mapProviderError, ProviderHttpError } from './provider-errors'

/** Never return the provider body, request headers, URL, or an arbitrary error string. */
export function modelListDiagnostic(error: unknown): ModelListDiagnostic {
  const rawStatus = error instanceof ProviderHttpError ? error.status : null
  const status = Number.isInteger(rawStatus) && rawStatus! >= 400 && rawStatus! <= 599 ? rawStatus : null
  const mapped = mapProviderError(String(error), status).kind
  return { stage: 'model-list', status, kind: MODEL_LIST_ERROR_KINDS.includes(mapped) ? mapped : 'unknown' }
}
