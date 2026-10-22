
PPH (People's Party of Heverty) Trading Computer for Elite Dangerous

An application that is comprised of:

- a postgres database
- a zeromq listener to https://github.com/EDCD/EDDN zeromq endpoint to consume incoming data.
- a discord bot (using bun) that provides commands that read data from the database to provide users with elite dangerous market data and tools:
  - A few examples:
    - A command that returns all the most profitable trades between 2 systems, stations, etc.
    - A command that finds trade routes that result in loss trades so players can use those to undermine a faction's economy.
    - A command that finds the cheapest recorded buying price for a commodity and it's location
    - A command that finds the most expensive selling price for a commodity and it's location
  
  - This bot will use selected event data from the EDDN listener, that is saved into postgres, to achieve all that and more.
  - This bot needs be structured in a way that it makes it easier to include new commands


AGENT'S TASK:

- Do an extensive research of all the components of the application and other elite dangerous third party tools that could be leveraged to create such an application.
  - This research must include researching the relevant EDDN events to watch for and the best way to store the relevant information in the database.
  - Records must have a time to live, so that we are not storing data forever, so we need a cleanup based on that.
  - We will be using docker compose to orchestrate all the components (db, listener, bot). Research for it.
- Create an implementation plan for this application, broken into documentation files for each phase. Record all research and documentation in the /docs directory of the project.
- Ask any questions regarding the implementation, such as my opinion between different choices of design and whatever feels relevant.


