export * from './assist'

export interface HealthResponse {
  status: 'ok'
  service: string
  time: string
}
