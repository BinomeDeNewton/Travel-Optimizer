"""Custom exceptions for the travel optimizer."""

class TravelOptimizerError(Exception):
    """Base error for pipeline failures."""


class ValidationError(TravelOptimizerError):
    """Raised when inputs are invalid or incomplete."""


class ProviderError(TravelOptimizerError):
    """Raised when an external provider fails."""


class StepFailedError(TravelOptimizerError):
    """Raised when a pipeline step fails."""
