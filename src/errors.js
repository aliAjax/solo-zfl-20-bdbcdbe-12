/**
 * 领域错误：带 HTTP 状态码，service 层抛出，HTTP 层统一捕获。
 */
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/** 422 语义性校验失败（业务规则不满足，非请求格式错误） */
HttpError.unprocessable = (message, details) => new HttpError(422, message, details);
/** 409 状态冲突（并发占用、非法状态流转） */
HttpError.conflict = (message, details) => new HttpError(409, message, details);
/** 400 请求格式错误 */
HttpError.badRequest = (message, details) => new HttpError(400, message, details);
/** 404 资源不存在 */
HttpError.notFound = (message) => new HttpError(404, message);

module.exports = { HttpError };
