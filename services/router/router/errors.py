class RouterError(Exception):
    """Rendered as HTTP `status` with body {"error": {"code", "message"}}."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
