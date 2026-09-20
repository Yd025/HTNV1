import * as Sentry from '@sentry/nextjs';
import type { NextPage } from 'next';
import NextError, { type ErrorProps } from 'next/error';

const ErrorPage: NextPage<ErrorProps> = props => <NextError statusCode={props.statusCode} />;

ErrorPage.getInitialProps = async context => {
  await Sentry.captureUnderscoreErrorException(context);
  return NextError.getInitialProps(context);
};

export default ErrorPage;
