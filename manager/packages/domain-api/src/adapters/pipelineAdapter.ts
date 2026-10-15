import type { ListWarning } from "../schema/envelope.js";
import type { Pipeline } from "../schema/pipeline.js";

// 라이브 Pipeline 공급 capability. ServiceAdapter(v1)와 분리해 계약 버전을 건드리지 않는다
// (queryHistory.ts와 같은 D2 방식). 구현체는 절대 throw하지 않는다: upstream 실패는
// warnings로 표현하고 pipelines는 빈 배열로 둔다(ADR-0002 partial-failure semantics).
export interface PipelineSnapshot {
  pipelines: Pipeline[];
  warnings: ListWarning[];
  /** 상세 조회가 누락되어 sink stage 등이 빠진 pipeline id(목록에는 PARTIAL 경고와 함께 포함됨). */
  incompletePipelineIds: string[];
}

// unavailable: upstream를 읽을 수 없어 "없음"과 "모름"을 구분할 수 없는 상태(404가 아니라 503으로 보고).
export interface PipelineLookup {
  pipeline: Pipeline | undefined;
  warnings: ListWarning[];
  unavailable: boolean;
}

export interface PipelineAdapter {
  listPipelines(): Promise<PipelineSnapshot>;
  getPipeline(id: string): Promise<PipelineLookup>;
}
